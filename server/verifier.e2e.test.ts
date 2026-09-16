// Phase 3 part 3, end to end on the fake engine: when a board task's turn
// ends, the verifier judges it. A task the fake judges "not complete" goes
// back to ready once, runs again, is judged again and is left in review
// with its verdict and attempts 2; a plain task is judged complete and
// stays in review. POSIX-gated like the budget e2e.
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
posixOnly("the verifier judges a finished board task", () => {
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
  beforeAll(async () => {
    chmodSync(fake("fake-claude-cli.ts"), 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-verify-e2e-"));
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

  it("sends a not-complete task back once with the verdict, then leaves it in review; a complete task stays in review with its verdict", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Worker" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" }, approvalMode: "auto", acknowledgeLocalAuto: true })).status).toBe(200);
    const flawed = (await api("POST", "/api/tasks", { title: "Never enough", body: "say hi [[fake:incomplete]]", assigneeBotId: bot.id })).body.task;
    const fine = (await api("POST", "/api/tasks", { title: "Just right", body: "say hi", assigneeBotId: bot.id })).body.task;
    for (const id of [flawed.id, fine.id]) expect((await api("PATCH", `/api/tasks/${id}`, { status: "ready" })).status).toBe(200);

    // the plain task: one attempt, judged complete, left in review
    await until(async () => (await task(fine.id))?.verdict != null, "the plain task's verdict");
    const good = await task(fine.id);
    expect(good.status).toBe("review");
    expect(good.verdict.isComplete).toBe(true);
    expect(good.verdict.line).toMatch(/^Verified: complete/);
    expect(good.attempts).toBe(1);

    // the flawed task: judged not complete, retried once, judged again, left for a person
    await until(async () => { const t = await task(flawed.id); return t?.attempts === 2 && t?.verdict?.attempt === 2; }, "the second attempt's verdict", 300_000);
    const bad = await task(flawed.id);
    expect(bad.status).toBe("review");
    expect(bad.verdict.isComplete).toBe(false);
    expect(bad.verdict.line).toMatch(/^Verified: not complete/);
    const comments = (await api("GET", `/api/tasks/${flawed.id}/comments`)).body.comments.map((c: any) => c.text);
    expect(comments.filter((c: string) => c.startsWith("Verified: not complete")).length).toBe(2);
    // the retry's prompt carried the verdict: the run thread's second user message says so
    const messages = (await api("GET", `/api/threads/${bad.threadId}/messages?limit=50`)).body.messages as any[];
    expect(messages.filter((m) => m.role === "user" && /judged not complete/.test(m.text ?? "")).length).toBeGreaterThanOrEqual(1);
  }, 600_000);
});
