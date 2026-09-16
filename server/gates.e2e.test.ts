// Phase 3 part 1, end to end on the fake engine: a board task whose bot
// works in a project folder gets that folder's gates run when its turn
// ends — results on the task, the scope line in the result and a comment
// with the failing tail — and a folder without gates gets nothing.
// POSIX-gated like the budget e2e.
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
posixOnly("a board task's turn ends and the folder's gates run", () => {
  const PORT = 18800 + Math.floor(Math.random() * 10_000);
  const BASE = `http://127.0.0.1:${PORT}`;
  let child: ChildProcess;
  let home = "";
  let repo = "";
  let bare = "";
  let stderr = "";
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const task = async (id: string) => (await api("GET", "/api/tasks")).body.tasks.find((t: any) => t.id === id);
  const until = async (pred: () => Promise<boolean>, what: string, ms = 150_000) => {
    const deadline = Date.now() + ms;
    while (!(await pred())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  beforeAll(async () => {
    chmodSync(fake("fake-claude-cli.ts"), 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-gates-e2e-"));
    repo = join(home, "repo");
    bare = join(home, "bare");
    mkdirSync(repo, { recursive: true });
    mkdirSync(bare, { recursive: true });
    // typecheck passes, test fails — the scope line must say both
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: { typecheck: "node -e 0", test: "node -e \"console.error('1 failed'); process.exit(1)\"" } }));
    writeFileSync(join(bare, "notes.txt"), "no scripts here");
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
      instances: { claude: { driver: "claudeAgent", environment: {}, config: { cli: fake("fake-claude-cli.ts"), fullAuto: true } } },
      features: { board: true },
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

  it("runs the gates, keeps them on the task, prefixes the result with the scope line and leaves a comment with the failing tail; a folder with no gates gets nothing", async () => {
    const worker = (await api("POST", "/api/bots", { name: "Worker" })).body.bot;
    expect((await api("PATCH", `/api/bots/${worker.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" }, approvalMode: "auto", acknowledgeLocalAuto: true, cwd: repo })).status).toBe(200);
    const idle = (await api("POST", "/api/bots", { name: "Idle" })).body.bot;
    expect((await api("PATCH", `/api/bots/${idle.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" }, approvalMode: "auto", acknowledgeLocalAuto: true, cwd: bare })).status).toBe(200);

    const gated = (await api("POST", "/api/tasks", { title: "Ship the fix", body: "say hi", assigneeBotId: worker.id })).body.task;
    const plain = (await api("POST", "/api/tasks", { title: "Say hi", body: "say hi", assigneeBotId: idle.id })).body.task;
    for (const id of [gated.id, plain.id]) expect((await api("PATCH", `/api/tasks/${id}`, { status: "ready" })).status).toBe(200);

    await until(async () => (await task(gated.id))?.gates !== null && (await task(gated.id))?.gates !== undefined, "the gates to run on the gated task");
    const g = await task(gated.id);
    expect(g.status).toBe("review");
    expect(g.gates.results.map((r: any) => `${r.name}:${r.status}`)).toEqual(["typecheck:pass", "test:fail"]);
    expect(g.gates.scope).toMatch(/^Gates: typecheck pass \(\d+ s\), test fail \(\d+ s\)\.$/);
    expect(g.result.startsWith(g.gates.scope)).toBe(true);
    expect(g.result).toContain("[digest]");
    const comments = (await api("GET", `/api/tasks/${gated.id}/comments`)).body.comments.map((c: any) => c.text);
    expect(comments.some((c: string) => c.startsWith(g.gates.scope) && c.includes("1 failed"))).toBe(true);

    await until(async () => (await task(plain.id))?.status === "review", "the plain task to settle");
    const p = await task(plain.id);
    expect(p.gates).toBeNull();
    expect(p.result.startsWith("[digest]")).toBe(true);
    const plainComments = (await api("GET", `/api/tasks/${plain.id}/comments`)).body.comments.map((c: any) => c.text);
    expect(plainComments.some((c: string) => c.startsWith("Gates:"))).toBe(false);
  }, 240_000);
});
