// Mid-turn steering, end to end: boots the real harness with the fake claude
// CLI in `slow` mode (a gap after the tool result the way a real turn has
// between model calls), sends a message WHILE the turn runs, and asserts
// it is taken into the turn — 202 steered; in the transcript in order and
// marked; folded into the reply — while an engine without a live session
// falls back to the server-side queue.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("mid-turn steering e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-steer-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "slow" }, config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" } },
          // no live session: a message while busy uses the server-side queue
          acp: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "hang" }, config: { cli: FAKE_ACP, fullAuto: true } },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it(
    "a message during a Claude turn is steered into it: 202, in the transcript in order and marked, folded into the reply",
    async () => {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claude", model: "claude-fake" } });
      const instances = (await api("GET", "/api/instances")).body.instances;
      expect(instances.find((i: any) => i.instanceId === "claude").capabilities.queueing).toBe(true);

      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
      await waitFor(async () => (await getBot(created.id)).busy === true, "the turn to start");
      // the fake pauses after its tool result; this lands inside that gap
      await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.kind === "activity"), "the tool chip");
      const second = await api("POST", `/api/bots/${created.id}/messages`, { text: "and also this" });
      expect(second.status).toBe(202);
      expect(second.body.steered).toBe(true);

      await waitFor(async () => (await getBot(created.id)).busy === false, "the turn to settle");
      const bot = await getBot(created.id);
      const texts = bot.messages.filter((m: any) => m.kind === "text").map((m: any) => `${m.role}:${m.text}`);
      // order: greeting, first, the fake's opening line, the steered message
      // (appended when it was sent — mid-turn), then ONE reply carrying it
      expect(texts.slice(1)).toEqual([
        "user:first",
        "bot:hello from fake claude",
        "user:and also this",
        "bot:reply to: first + steered: and also this",
      ]);
      const steered = bot.messages.find((m: any) => m.text === "and also this");
      expect(steered.steered).toBe(true);
      // one turn, not two: exactly one reply
      expect(bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text.startsWith("reply to:"))).toHaveLength(1);
    },
    40_000,
  );

  it("an engine without a live session preserves the message in the server-side queue", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fake-model" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the hung turn to start");
    const queued = await api("POST", `/api/bots/${created.id}/messages`, { text: "second" });
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "second")).toBe(false);
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.text === "second"),
      "the queued message to begin its turn",
    );
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the queued turn to settle");
  }, 30_000);
});
