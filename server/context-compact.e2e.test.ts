// Compaction recycle, end to end: a local-ceiling override forces a
// provider-side refresh. Compact clears the ACP resume cursor so the host
// session actually resets (second session/new). UI chat stays; the state
// vector is for the host, not the ACP prompt.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 19800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("session compaction recycle (fake ACP)", () => {
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

  const getBot = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);

  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-compact-test-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          happy: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: true } },
        },
      }),
    );

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      // Fake ACP reports 10 input tokens per turn. 80% of 12 is 9.6, so the
      // second turn recycles. Isolated to this fixture so other e2e stay put.
      OPENMAUSBOT_CONTEXT_CEILING: "12",
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it(
    "resets the engine session and records a compaction vector for the provider",
    async () => {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "happy", model: "fake-model" },
      });

      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "remember the vault path /secret/vault" })).status).toBe(202);
      await waitFor(async () => {
        const b = await getBot(created.id);
        return !b.busy && b.messages.some((m: { role: string; kind: string; text?: string }) => m.role === "bot" && m.kind === "text" && m.text?.includes("fake acp"));
      }, "the first reply");

      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "what is the vault path?" })).status).toBe(202);
      await waitFor(async () => {
        const b = await getBot(created.id);
        return !b.busy && b.messages.some((m: { kind: string }) => m.kind === "compaction");
      }, "the compaction record");

      const bot = await getBot(created.id);
      expect(bot.messages.some((m: { kind: string }) => m.kind === "compaction")).toBe(true);
      expect(bot.messages.some((m: { text?: string }) => m.text === "remember the vault path /secret/vault")).toBe(true);

      const log = readFileSync(join(home, ".openmausbot", "native", `${bot.threadId}.ndjson`), "utf8");
      const records = log
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const methods = records.filter((e) => e.dir === "out").map((e) => e.msg?.method);
      // First turn opens the session; compact clears resume → second session/new.
      expect(methods.filter((m: string) => m === "session/new")).toHaveLength(2);

      const prompts = records
        .filter((e) => e.dir === "out" && e.msg?.method === "session/prompt")
        .map((e) => JSON.stringify(e.msg.params));
      const continued = prompts.at(-1) ?? "";
      expect(continued).toContain("what is the vault path?");
      expect(continued).not.toContain("Current task state:");
      expect(continued.toLowerCase()).not.toContain("joining this conversation");
      expect(continued.toLowerCase()).not.toContain("you restarted");
      expect(continued.toLowerCase()).not.toContain("rewound this conversation");
    },
    40_000,
  );
});
