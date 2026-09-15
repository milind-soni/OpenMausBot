// The headless bench driver, end to end and across engines (Phase 0, item
// 0.8 with the standing "every engine" rule): POST /api/bench/run starts one
// detached, unattended turn on a bot; GET /api/bench/runs/:id reports the
// result and, once terminal, the trajectory (messages, digest, usage rows).
// Budgets are enforced from the side: a turn that will not finish is
// interrupted when it crosses steps or minutes, and the result says which.
// The script under scripts/bench/run.ts drives the same routes and writes
// result.json + trajectory.json.
// Same POSIX gating as branching.test.ts (the fakes are shebang scripts).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

const ENGINES = [
  { id: "claude", driver: "claudeAgent", cli: "fake-claude-cli.ts", env: { FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ name: "Bash", input: { command: "ls" }, ok: true, output: "a" }, { name: "Read", input: { file_path: "a" }, ok: true, output: "b" }]) }, steps: 2 },
  { id: "codex", driver: "codex", cli: "fake-codex-app-server.ts", env: {}, steps: 1 },
  { id: "acp", driver: "grokAgent", cli: "fake-acp-cli.ts", env: {}, steps: 1 },
  { id: "pi", driver: "piAgent", cli: "fake-pi-cli.ts", env: { FAKE_PI_MODE: "tooluse" }, steps: 1 },
] as const;

posixOnly("bench driver e2e (every fake engine)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  const gate = () => join(home, "never-written.gate");

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const newBot = async (instanceId: string) => {
    const created = (await api("POST", "/api/bots", { name: `Bench ${instanceId}` })).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId, model: "fake-model" } })).status).toBe(200);
    return created;
  };
  const runToEnd = async (botId: string, body: Record<string, unknown>) => {
    const started = await api("POST", "/api/bench/run", { botId, task: "List the files, then say done.", ...body });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const id = started.body.run.id;
    await expect.poll(async () => (await api("GET", `/api/bench/runs/${id}`)).body.run.status, { timeout: 30_000, message: stderr.slice(-2000) }).not.toBe("running");
    return (await api("GET", `/api/bench/runs/${id}`)).body;
  };

  beforeAll(async () => {
    for (const e of ENGINES) chmodSync(fake(e.cli), 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-bench-e2e-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    const instances: Record<string, unknown> = {};
    for (const e of ENGINES) instances[e.id] = { driver: e.driver, environment: e.env, config: { cli: fake(e.cli), fullAuto: true } };
    // a turn that never finishes on its own: three tool calls, then a reply
    // held behind a gate nobody writes — only a budget can end it
    instances.stuck = {
      driver: "claudeAgent",
      environment: {
        FAKE_CLAUDE_MODE: "slow",
        FAKE_CLAUDE_SLOW_FINISH_GATE: gate(),
        FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([1, 2, 3].map((n) => ({ name: "Bash", input: { command: `step ${n}` }, ok: true, output: "ok" }))),
      },
      config: { cli: fake("fake-claude-cli.ts"), fullAuto: true },
    };
    writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({ instances }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it.each(ENGINES)("$id: one detached run settles with a result and a readable trajectory", async (engine) => {
    const bot = await newBot(engine.id);
    const { run, trajectory } = await runToEnd(bot.id, { budget: "steps=50,tokens=100000,minutes=2" });
    expect(run).toMatchObject({ status: "settled", botId: bot.id, driverKind: engine.driver, model: "fake-model", turns: 1, budget: { steps: 50, tokens: 100_000, minutes: 2 } });
    expect(run.steps).toBeGreaterThanOrEqual(engine.steps);
    expect(run.durationMs).toBeGreaterThan(0);
    expect(trajectory.messages.some((m: any) => m.role === "user" && m.text?.includes("List the files"))).toBe(true);
    expect(trajectory.messages.some((m: any) => m.kind === "digest")).toBe(true);
    expect(trajectory.usage.length).toBeGreaterThanOrEqual(1);
    expect(trajectory.usage[0]).toMatchObject({ threadId: run.threadId, trigger: { kind: "bench", runId: run.id } });
    // the run lives in its own detached task; the bot's selected task is untouched
    const state = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id);
    expect(state.tasks.some((t: any) => t.threadId === run.threadId && t.title.startsWith("bench"))).toBe(true);
    expect(state.threadId).not.toBe(run.threadId);
  }, 60_000);

  it("stops a run that crosses its step budget and says so", async () => {
    const bot = await newBot("stuck");
    const { run } = await runToEnd(bot.id, { budget: "steps=2,minutes=5" });
    expect(run).toMatchObject({ status: "budget_exceeded", exceeded: "steps" });
    expect(run.steps).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id).busy, { timeout: 15_000 }).toBe(false);
  }, 60_000);

  it("stops a run that crosses its time budget", async () => {
    const bot = await newBot("stuck");
    const { run } = await runToEnd(bot.id, { budget: "steps=50,minutes=0.02" });
    expect(run).toMatchObject({ status: "budget_exceeded", exceeded: "minutes" });
    expect(run.durationMs).toBeGreaterThanOrEqual(1_000);
  }, 60_000);

  it("refuses a bad request plainly", async () => {
    expect((await api("POST", "/api/bench/run", { botId: "nope", task: "x" })).status).toBe(404);
    const bot = await newBot("claude");
    expect((await api("POST", "/api/bench/run", { botId: bot.id, task: "" })).status).toBe(400);
    expect((await api("POST", "/api/bench/run", { botId: bot.id, task: "x", budget: "hours=1" })).status).toBe(400);
    expect((await api("GET", "/api/bench/runs/missing")).status).toBe(404);
  });

  it("the script drives the same run and writes result.json + trajectory.json", async () => {
    const bot = await newBot("claude");
    const out = join(home, "bench-out");
    const taskFile = join(home, "task.md");
    writeFileSync(taskFile, "List the files, then say done.\n");
    const proc = spawnSync(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts", "bench", "run.ts"), "--url", BASE, "--bot", bot.id, "--task", `@${taskFile}`, "--budget", "steps=50,minutes=2", "--network", "allow=example.com", "--out", out], { encoding: "utf8", cwd: ROOT, timeout: 60_000 });
    expect(proc.status, proc.stderr).toBe(0);
    const printed = JSON.parse(proc.stdout);
    expect(printed).toMatchObject({ status: "settled", botId: bot.id, network: { allow: ["example.com"], enforced: false } });
    expect(existsSync(join(out, "result.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "trajectory.json"), "utf8")).messages.length).toBeGreaterThan(1);
  }, 90_000);
});
