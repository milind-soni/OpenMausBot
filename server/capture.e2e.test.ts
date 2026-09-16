// Phase 4 part 1, end to end on the fake engine: a bot with capture on
// learns a fact said in passing; small talk, a board run and a bot with
// capture off yield nothing. POSIX-gated like the other board e2e tests.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const posixOnly = describe.skipIf(process.platform === "win32");
posixOnly("fact capture after attended turns", () => {
  const PORT = 18800 + Math.floor(Math.random() * 10_000);
  const BASE = `http://127.0.0.1:${PORT}`;
  let child: ChildProcess;
  let home = "";
  let stderr = "";
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const until = async (pred: () => Promise<boolean>, what: string, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (!(await pred())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 400));
    }
  };
  const memoryOf = (botId: string) => { const p = join(home, ".openmausbot", "workspaces", botId, "MEMORY.md"); return existsSync(p) ? readFileSync(p, "utf8") : ""; };
  const turn = async (botId: string, threadId: string, text: string) => {
    expect((await api("POST", `/api/bots/${botId}/messages`, { text, threadId })).status).toBe(202);
    await until(async () => { const b = (await api("GET", "/api/bots?messages=0")).body.bots.find((x: any) => x.id === botId); return b && !b.busy; }, "the turn to finish");
  };
  beforeAll(async () => {
    chmodSync(fake("fake-claude-cli.ts"), 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-capture-e2e-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
      instances: { claude: { driver: "claudeAgent", environment: {}, config: { cli: fake("fake-claude-cli.ts"), fullAuto: true } } },
      features: { board: true },
      memory: { captureQuietMs: 1_500 },
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

  it("captures a passing fact into the notebook with date, source and the captured marker; ignores small talk, a board run, and a bot with capture off", async () => {
    const on = (await api("POST", "/api/bots", { name: "Listener" })).body.bot;
    const off = (await api("POST", "/api/bots", { name: "Deaf" })).body.bot;
    for (const bot of [on, off]) expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" }, approvalMode: "auto", acknowledgeLocalAuto: true })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${on.id}`, { memoryCapture: true })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${on.id}`, { memoryCapture: "yes" })).status).toBe(400);

    // a fact in passing, then small talk, in the person's own chat
    await turn(on.id, on.threadId, "By the way, my dog is called Biscuit.");
    await turn(on.id, on.threadId, "hello again, how are you");
    await turn(on.id, on.threadId, "maybe the office is moving, not sure");
    await until(async () => /Biscuit/.test(memoryOf(on.id)), "the capture to land", 30_000);
    const bodies = (text: string) => text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.split(" · ").at(-1) ?? "");
    const notebook = memoryOf(on.id);
    const line = notebook.split("\n").find((l) => l.includes("Biscuit"))!;
    // the default importance (3) is omitted by the grammar
    expect(line).toMatch(/^- \d{4}-\d{2}-\d{2} · from chat "[^"]*", captured · (?:importance [1-5] · )?/);
    expect(bodies(notebook).some((b) => /hello again/.test(b))).toBe(false);
    expect(bodies(notebook).some((b) => /office is moving/.test(b))).toBe(false); // low confidence dropped
    // the same fact again is not appended twice
    await turn(on.id, on.threadId, "As I said, my dog is called Biscuit.");
    await new Promise((r) => setTimeout(r, 4_000));
    // count bodies, not source labels: the chat's title carries the word too
    expect(bodies(memoryOf(on.id)).filter((b) => /biscuit/i.test(b)).length).toBe(1);

    // a board run (unattended) on the same bot captures nothing
    const task = (await api("POST", "/api/tasks", { title: "Say it", body: "The password is swordfish. Reply ok.", assigneeBotId: on.id })).body.task;
    expect((await api("PATCH", `/api/tasks/${task.id}`, { status: "ready" })).status).toBe(200);
    await until(async () => ((await api("GET", "/api/tasks")).body.tasks.find((t: any) => t.id === task.id)?.status) === "review", "the board run to settle", 150_000);
    await new Promise((r) => setTimeout(r, 4_000));
    expect(bodies(memoryOf(on.id)).some((b) => /swordfish/.test(b))).toBe(false);

    // capture off: nothing
    await turn(off.id, off.threadId, "My cat is called Marble.");
    await new Promise((r) => setTimeout(r, 4_000));
    expect(bodies(memoryOf(off.id)).some((b) => /Marble/.test(b))).toBe(false);
  }, 300_000);
});
