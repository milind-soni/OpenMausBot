// A board task's money cap, end to end (Phase 2 part 1, decision 11): the
// fake Claude reports total_cost_usd 0.01 per turn; a task capped at $0.014
// runs once (70% warning), runs again and pauses with "paused, needs a
// budget increase", is never dispatched while paused, and resumes when a
// person raises the cap. Its result is the turn's digest. POSIX-gated like
// branching.test.ts.
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

posixOnly("a board task pauses at its money cap and resumes when it is raised", () => {
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
  const until = async (pred: () => Promise<boolean>, what: string, ms = 90_000) => {
    const deadline = Date.now() + ms;
    while (!(await pred())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  beforeAll(async () => {
    chmodSync(fake("fake-claude-cli.ts"), 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-budget-"));
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

  it("warns at 70%, pauses at the cap, stays paused, and resumes on a raised cap; the result is the digest", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Worker" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "fake-model" }, approvalMode: "auto", acknowledgeLocalAuto: true })).status).toBe(200);
    const created = await api("POST", "/api/tasks", { title: "Spend carefully", body: "say hi", assigneeBotId: bot.id, owner: "person", budgetUsd: 0.014 });
    expect(created.status).toBe(201);
    const id = created.body.task.id as string;
    expect((await api("PATCH", `/api/tasks/${id}`, { status: "ready" })).status).toBe(200);
    // the dispatcher ticks every 30 s: one turn at $0.01 lands the task in
    // review with 70% spent and a warning comment
    await until(async () => (await task(id))?.status === "review", "the first turn to settle");
    let t = await task(id);
    expect(t.spentUsd).toBeCloseTo(0.01, 5);
    let comments = (await api("GET", `/api/tasks/${id}/comments`)).body.comments.map((c: any) => c.text);
    expect(comments).toEqual(["70% of this task's budget is spent ($0.010 of $0.014)."]);
    // the digest is the result
    await until(async () => String((await task(id))?.result ?? "").startsWith("[digest]"), "the digest to become the result", 20_000);
    expect((await task(id)).result).toContain("[digest]");
    // send it round again: the second turn crosses the cap
    expect((await api("PATCH", `/api/tasks/${id}`, { status: "ready" })).status).toBe(200);
    await until(async () => (await task(id))?.status === "blocked", "the second turn to pause the task");
    t = await task(id);
    expect(t).toMatchObject({ status: "blocked", blockedReason: "paused, needs a budget increase" });
    expect(t.spentUsd).toBeCloseTo(0.02, 5);
    comments = (await api("GET", `/api/tasks/${id}/comments`)).body.comments.map((c: any) => c.text);
    expect(comments[1]).toContain("paused, needs a budget increase");
    // a cap below what is spent is refused; a raised cap resumes the task
    expect((await api("PATCH", `/api/tasks/${id}`, { budgetUsd: 0.015 })).status).toBe(400);
    const raised = await api("PATCH", `/api/tasks/${id}`, { budgetUsd: 0.05 });
    expect(raised.status).toBe(200);
    expect(raised.body.task).toMatchObject({ status: "ready", blockedReason: null, budgetUsd: 0.05 });
    await until(async () => (await task(id))?.status === "review", "the resumed task to run again");
    expect((await task(id)).spentUsd).toBeCloseTo(0.03, 5);
    // the ledger booked three priced turns on the task's thread
    const metrics = (await api("GET", "/api/metrics?from=2026-01-01&to=2026-12-31")).body;
    expect(metrics.bots.find((b: any) => b.botId === bot.id)?.turns).toBe(3);
  }, 240_000);
});
