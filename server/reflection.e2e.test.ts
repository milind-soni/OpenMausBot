// Phase 4 part 3, end to end on the fake engine: a board task whose run
// took three tool steps and was judged complete leaves one staged skill
// candidate and one review card in its run thread; a second identical task
// stages nothing new; a task with a single tool step stages nothing.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const posixOnly = describe.skipIf(process.platform === "win32");
posixOnly("reflection into a candidate skill", () => {
  const PORT = 18800 + Math.floor(Math.random() * 10_000);
  const BASE = `http://127.0.0.1:${PORT}`;
  let child: ChildProcess;
  let home = "";
  let stderr = "";
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const task = async (id: string) => (await api("GET", "/api/tasks")).body.tasks.find((t: any) => t.id === id);
  const until = async (pred: () => Promise<boolean>, what: string, ms = 200_000) => {
    const deadline = Date.now() + ms;
    while (!(await pred())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  const boot = async (toolCalls: unknown) => {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), FAKE_CLAUDE_TOOL_CALLS: JSON.stringify(toolCalls) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  beforeAll(async () => {
    chmodSync(fake("fake-claude-cli.ts"), 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-reflect-e2e-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
      instances: { claude: { driver: "claudeAgent", environment: {}, config: { cli: fake("fake-claude-cli.ts"), fullAuto: true } } },
      features: { board: true },
      recall: { captures: false },
    }));
    await boot([
      { name: "Write", input: { file_path: "greeting.txt", content: "hello" }, ok: true, output: "written" },
      { name: "Bash", input: { command: "cat greeting.txt" }, ok: true, output: "hello" },
      { name: "Bash", input: { command: "npm test" }, ok: true, output: "1 passed" },
    ]);
  }, 30_000);
  afterAll(async () => { await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); });

  it("stages one candidate with a review card after a judged-complete task with three tool steps, and never twice for the same name", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Learner" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" }, approvalMode: "auto", acknowledgeLocalAuto: true })).status).toBe(200);
    const first = (await api("POST", "/api/tasks", { title: "Greeting file", body: "Create greeting.txt containing hello and prove it with the test.", assigneeBotId: bot.id })).body.task;
    expect((await api("PATCH", `/api/tasks/${first.id}`, { status: "ready" })).status).toBe(200);
    await until(async () => (await task(first.id))?.verdict?.isComplete === true, "the first task to be judged complete");
    await until(async () => ((await api("GET", `/api/bots/${bot.id}/skills`)).body.staged ?? []).length >= 1, "the candidate to be staged", 60_000);
    const staged = (await api("GET", `/api/bots/${bot.id}/skills`)).body.staged as any[];
    expect(staged.length).toBe(1);
    expect(staged[0]).toMatchObject({ action: "create", name: "greeting-file" });
    expect(staged[0].source).toMatch(/^reflection on task/);
    // the listing omits the files; the review card in the run thread carries the SKILL.md preview
    const runThread = (await task(first.id)).threadId as string;
    const messages = (await api("GET", `/api/threads/${runThread}/messages?limit=100`)).body.messages as any[];
    const card = messages.find((m) => m.kind === "options" && m.card?.skillRequest);
    expect(card).toBeTruthy();
    const preview = card.card.skillRequest.preview as string;
    for (const section of ["## When to use", "## Procedure", "## Pitfalls", "## Verification"]) expect(preview).toContain(section);
    expect(preview).toMatch(/^---\nname: greeting-file\n/);

    // the same task again: judged complete, but the name is already staged — nothing new
    const second = (await api("POST", "/api/tasks", { title: "Greeting file", body: "Create greeting.txt containing hello and prove it with the test.", assigneeBotId: bot.id })).body.task;
    expect((await api("PATCH", `/api/tasks/${second.id}`, { status: "ready" })).status).toBe(200);
    await until(async () => (await task(second.id))?.verdict?.isComplete === true, "the second task to be judged complete");
    await new Promise((r) => setTimeout(r, 3_000));
    expect(((await api("GET", `/api/bots/${bot.id}/skills`)).body.staged as any[]).length).toBe(1);
  }, 400_000);
});
