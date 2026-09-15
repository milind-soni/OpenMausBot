// The engine fallback ladder, end to end (Phase 2 part 2, decision 12):
// the fake Claude fails the way an out-of-quota CLI does; a bot that named
// an alternate continues there silently, with the switch recorded on the
// task and a chip in the thread; a bot without one gets the quota card and
// no reply. POSIX-gated like branching.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const posixOnly = describe.skipIf(process.platform === "win32");

interface Msg { id: string; role: string; kind: string; text?: string; tool?: { name: string }; card?: { fixedOptions?: boolean; options?: unknown[] } }

posixOnly("engine fallback (decision 12)", () => {
  const PORT = 18800 + Math.floor(Math.random() * 10_000);
  const BASE = `http://127.0.0.1:${PORT}`;
  let child: ChildProcess;
  let home = "";
  let stderr = "";
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots?messages=200")).body.bots.find((b: any) => b.id === id);
  /** Send one message and wait until the bot is idle and `pred` holds over
   * the messages that arrived after it (the greeting is not a reply). */
  const send = async (botId: string, text: string, pred: (fresh: Msg[]) => boolean, what: string) => {
    const before = new Set(((await getBot(botId)).messages as Msg[]).map((m) => m.id));
    expect((await api("POST", `/api/bots/${botId}/messages`, { text })).status).toBe(202);
    const deadline = Date.now() + 40_000;
    for (;;) {
      const b = await getBot(botId);
      const fresh = (b.messages as Msg[]).filter((m) => !before.has(m.id));
      if (!b.busy && pred(fresh)) return { bot: b, fresh };
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2500)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  beforeAll(async () => {
    for (const cli of ["fake-claude-cli.ts", "fake-acp-cli.ts"]) chmodSync(fake(cli), 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-fallback-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
      instances: {
        claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "quota" }, config: { cli: fake("fake-claude-cli.ts"), fullAuto: true } },
        acp: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "echo-gated" }, config: { cli: fake("fake-acp-cli.ts"), fullAuto: true } },
      },
      recall: { captures: false },
    }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);
  afterAll(async () => { await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); });

  it("continues on the named alternate, records the switch on the task, and says so in the thread", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Falls back" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" }, fallback: { alternate: { instanceId: "acp", model: "fake-model" } } })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { fallback: { alternate: { instanceId: "nope", model: "x" } } })).status).toBe(400);
    const { bot: b, fresh: messages } = await send(bot.id, "hello, are you there?", (fresh) => fresh.some((m) => m.role === "bot" && m.kind === "text" && Boolean(m.text)), "a reply from the alternate");
    const reply = messages.filter((m) => m.role === "bot" && m.kind === "text").at(-1)!.text!;
    expect(reply).toContain("hello, are you there?");
    expect(messages.some((m) => m.kind === "activity" && m.tool?.name.startsWith("continuing on") && m.tool.name.includes("after quota on claude"))).toBe(true);
    expect(messages.some((m) => m.kind === "options")).toBe(false);
    const task = b.tasks.find((t: any) => t.threadId === bot.threadId);
    expect(task.modelSelection).toMatchObject({ instanceId: "acp" });
    expect(task.fallback).toMatchObject({ from: { instanceId: "claude" }, to: { instanceId: "acp" }, reason: "quota" });
    const ledger = readFileSync(join(home, ".openmausbot", "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.threadId === bot.threadId);
    expect(ledger.at(-1)?.driverKind).toBe("grokAgent");
  }, 60_000);

  it("without an alternate, offers the card and does not switch on its own", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Asks first" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" } })).status).toBe(200);
    const { bot: b, fresh: messages } = await send(bot.id, "hello?", (fresh) => fresh.some((m) => m.kind === "options"), "the quota card");
    expect(messages.some((m) => m.role === "bot" && m.kind === "text" && m.text)).toBe(false);
    expect(messages.some((m) => m.kind === "activity" && m.tool?.name.startsWith("continuing on"))).toBe(false);
    const task = b.tasks.find((t: any) => t.threadId === bot.threadId);
    expect(task.modelSelection).toMatchObject({ instanceId: "claude" });
    expect(task.fallback).toBeUndefined();
  }, 60_000);
});
