// Phase 3 part 4, end to end on the fake engine: a routine run is a graph
// (intake → work → check → judge → ship). A run completes with the verdict
// line in its output; a run the fake judges "not complete" fails with the
// verdict as its error; a run interrupted after its turn resumes at its
// next node on restart without the engine starting another turn.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const posixOnly = describe.skipIf(process.platform === "win32");
posixOnly("a routine run as a graph with checkpoints", () => {
  const PORT = 18800 + Math.floor(Math.random() * 10_000);
  const BASE = `http://127.0.0.1:${PORT}`;
  let child: ChildProcess;
  let home = "";
  let prompts = "";
  let stderr = "";
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const runOf = async (id: string) => ((await api("GET", "/api/routines")).body.runs as any[]).find((r) => r.id === id);
  const until = async (pred: () => Promise<boolean>, what: string, ms = 120_000) => {
    const deadline = Date.now() + ms;
    while (!(await pred())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 400));
    }
  };
  const promptCount = () => (existsSync(prompts) ? readFileSync(prompts, "utf8").split("\n").filter(Boolean).length : 0);
  const boot = async () => {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), FAKE_CLAUDE_PROMPTS: prompts };
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
    home = mkdtempSync(join(tmpdir(), "omb-graph-e2e-"));
    prompts = join(home, "prompts.log");
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
      instances: { claude: { driver: "claudeAgent", environment: {}, config: { cli: fake("fake-claude-cli.ts"), fullAuto: true } } },
      recall: { captures: false },
    }));
    await boot();
  }, 30_000);
  afterAll(async () => { await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); });

  it("completes a run with the verdict, fails a run the verifier rejects, and resumes an interrupted run at its next node without a new turn", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Runner" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" }, approvalMode: "auto", acknowledgeLocalAuto: true })).status).toBe(200);
    const routine = async (name: string, prompt: string) => (await api("POST", "/api/routines", { name, prompt, botId: bot.id, enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } })).body.routine;

    // 1. a run completes with check → judge → ship recorded on it
    const good = await routine("Good routine", "Report the fixture state.");
    const run1 = (await api("POST", `/api/routines/${good.id}/run`)).body.run;
    await until(async () => ["completed", "failed"].includes((await runOf(run1.id))?.status), "the good run to settle");
    const done1 = await runOf(run1.id);
    expect(done1.status).toBe("completed");
    expect(done1.verdict).toMatch(/Verified: complete/);
    expect(done1.output).toBe("hello from fake claude"); // the bot's report is untouched
    const graphs = new DatabaseSync(join(home, ".openmausbot", "graphs.db"));
    const nodes = (subject: string) => graphs.prepare("SELECT n.name, n.status FROM graph_nodes n JOIN graph_runs r ON r.id = n.run_id WHERE r.subject_id = ? ORDER BY n.position").all(subject) as Array<{ name: string; status: string }>;
    expect(nodes(run1.id).map((n) => `${n.name}:${n.status}`)).toEqual(["intake:done", "work:done", "check:skipped", "judge:done", "ship:done"]);

    // 2. a run the verifier rejects fails with the verdict as its error
    const bad = await routine("Bad routine", "Report the fixture state. [[fake:incomplete]]");
    const run2 = (await api("POST", `/api/routines/${bad.id}/run`)).body.run;
    await until(async () => ["completed", "failed"].includes((await runOf(run2.id))?.status), "the bad run to settle");
    const done2 = await runOf(run2.id);
    expect(done2.status).toBe("failed");
    expect(done2.error).toMatch(/^Verified: not complete/);

    // 3. simulate a crash after the turn: the good run is put back to running
    //    with judge and ship pending, the server restarts, and the run
    //    completes again from the checkpoint with no new engine turn
    const before = promptCount();
    await waitForExit(child, { signal: "SIGTERM" });
    const routinesFile = join(home, ".openmausbot", "routines.json");
    const state = JSON.parse(readFileSync(routinesFile, "utf8"));
    const stored = (state.runs as any[]).find((r) => r.id === run1.id);
    stored.status = "running";
    stored.finishedAt = undefined;
    stored.output = "hello from fake claude";
    writeFileSync(routinesFile, JSON.stringify(state));
    const graphRunId = (graphs.prepare("SELECT id FROM graph_runs WHERE subject_id = ?").get(run1.id) as { id: string }).id;
    graphs.prepare("UPDATE graph_runs SET status = 'running' WHERE id = ?").run(graphRunId);
    graphs.prepare("UPDATE graph_nodes SET status = 'running', output_json = NULL WHERE run_id = ? AND name = 'judge'").run(graphRunId);
    graphs.prepare("UPDATE graph_nodes SET status = 'pending', output_json = NULL WHERE run_id = ? AND name = 'ship'").run(graphRunId);
    graphs.close();
    stderr = "";
    await boot();
    await until(async () => (await runOf(run1.id))?.status === "completed", "the interrupted run to resume and complete");
    const resumed = await runOf(run1.id);
    expect(resumed.error).toBeUndefined();
    expect(resumed.verdict).toMatch(/Verified: complete/);
    // the engine never started a new turn: the fake's prompt log only grew by the verifier's one-shot, which is not logged there
    expect(promptCount()).toBe(before);
    const reopened = new DatabaseSync(join(home, ".openmausbot", "graphs.db"));
    const after = reopened.prepare("SELECT n.name, n.status FROM graph_nodes n WHERE n.run_id = ? ORDER BY n.position").all(graphRunId) as Array<{ name: string; status: string }>;
    reopened.close();
    expect(after.map((n) => `${n.name}:${n.status}`)).toEqual(["intake:done", "work:done", "check:skipped", "judge:done", "ship:done"]);
  }, 240_000);
});
