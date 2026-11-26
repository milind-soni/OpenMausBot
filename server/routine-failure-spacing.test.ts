// A routine whose runs keep failing stays on, and stops spending its bot's AI on a start every few minutes: the audit's
// scenario is a routine every 5 minutes whose tool server is dead, counted in turns started (each is at least one
// request to the AI) over a day.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FAILURE_FIRST_SPACING_MS, FAILURE_SPACING_MS, failedRuns, failureSpacing, failureSpacingAlert, failureSpacingLimits, runSpacing } from "./routine-failure-spacing.ts";
import { sessionHolds, startPrompt } from "./routine-recovery.ts";
import { RoutineManager, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const START = Date.parse("2026-11-16T08:00:00Z");
const DEAD_TOOL = "MCP server could not start; check its command and installation";
const OVERLOADED = "Claude is overloaded right now (HTTP 529). Wait a minute, then run it again.";
const NO_START = "Maus's cloud desktop didn't start. Change where this routine runs.";
const SPAWN_REFUSED = "spawn /usr/local/bin/claude EAGAIN";
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const failed = (id: string, at: number, more: Record<string, unknown> = {}) => ({ id, routineId: "r", status: "failed", error: DEAD_TOOL, createdAt: at, startedAt: at, finishedAt: at + 50, ...more });
const completed = (id: string, at: number) => ({ id, routineId: "r", status: "completed", createdAt: at, startedAt: at, finishedAt: at + 50 });
const routine = { id: "r", updatedAt: 0 };

describe("failed runs in a row", () => {
  it("space the routine's scheduled runs an hour after the third and four hours after each later one", () => {
    expect(failureSpacing(routine, [failed("a", 100), failed("b", 200)])).toBeNull();
    expect(failureSpacing(routine, [failed("a", 100), failed("b", 200), failed("c", 300)])).toMatchObject({ streak: 3, until: 350 + FAILURE_FIRST_SPACING_MS, last: { id: "c" } });
    expect(failureSpacing(routine, [failed("a", 100), failed("b", 200), failed("c", 300), failed("d", 400)])).toMatchObject({ streak: 4, until: 450 + FAILURE_SPACING_MS });
  });

  it("end with the first run that completes or a change to the routine", () => {
    const three = [failed("a", 100), failed("b", 200), failed("c", 300)];
    expect(failureSpacing(routine, [...three, completed("d", 400)])).toBeNull();
    expect(failureSpacing({ id: "r", updatedAt: 250 }, three)).toBeNull();
    expect(failureSpacing({ id: "other", updatedAt: 0 }, three)).toBeNull();
  });

  it("do not count a run that never started work", () => {
    const rows = [failed("a", 100), failed("b", 200), failed("paused", 300, { startedAt: undefined })];
    expect(failedRuns(routine, rows).map((run) => run.id)).toEqual(["b", "a"]);
    expect(failureSpacing(routine, [...rows, failed("c", 600)])).toMatchObject({ streak: 3, last: { id: "c" } });
  });

  it("end at a run only the owner's AI account stopped, and so does a spacing already begun", () => {
    const three = [failed("a", 100), failed("b", 200), failed("c", 300)];
    expect(failureSpacing(routine, three)).not.toBeNull();
    expect(failureSpacing(routine, [...three, failed("signed-out", 400, { ownerCause: "signed_out" })])).toBeNull();
    const after = [...three, failed("limit", 400, { ownerCause: "usage_limit" }), failed("d", 500), failed("e", 600)];
    expect(failedRuns(routine, after).map((run) => run.id)).toEqual(["e", "d"]);
    expect(failureSpacing(routine, after)).toBeNull();
  });

  it("tell the owner once, at the failure that begins the spacing", () => {
    const rows = [failed("a", 100), failed("b", 200), failed("c", 300)];
    expect(failureSpacingAlert(routine, rows.slice(0, 2), rows[1]!)).toBeUndefined();
    expect(failureSpacingAlert(routine, rows, rows[2]!)).toEqual({ detail: `${DEAD_TOOL} 3 runs in a row failed. It stays on, and tries again less often until a run completes.` });
    expect(failureSpacingAlert(routine, [...rows, failed("d", 400)], rows[2]!)).toBeUndefined();
    expect(failureSpacingAlert(undefined, rows, rows[2]!)).toBeUndefined();
    expect(failureSpacingAlert({ ...routine, enabled: false }, rows, rows[2]!)).toBeUndefined();
  });

  it("give way to the spacing for a cloud computer that did not start when that one holds as long", () => {
    const rows = [failed("a", 100, { error: NO_START }), failed("b", 200, { error: NO_START }), failed("c", 300, { error: NO_START })];
    expect(runSpacing(routine, rows)).toMatchObject({ behind: "no-start:c", why: "routines.server.part.computerNoStart" });
    expect(runSpacing(routine, [failed("a", 100), failed("b", 200), failed("c", 300)])).toMatchObject({ behind: "failed:c", why: "routines.server.part.runsFailed" });
    expect(runSpacing(routine, [failed("a", 100)])).toBeNull();
  });

  it("read their limits from the environment, and keep the defaults for anything that is not a whole number in range", () => {
    expect(failureSpacingLimits({})).toEqual({ runs: 3, firstMs: HOUR, laterMs: 4 * HOUR });
    expect(failureSpacingLimits({ OMB_ROUTINE_FAILURES_BEFORE_SPACING: "5", OMB_ROUTINE_FAILURE_SPACING_MS: "600000", OMB_ROUTINE_FAILURE_SPACING_MAX_MS: "1800000" })).toEqual({ runs: 5, firstMs: 10 * MINUTE, laterMs: 30 * MINUTE });
    expect(failureSpacingLimits({ OMB_ROUTINE_FAILURES_BEFORE_SPACING: "0", OMB_ROUTINE_FAILURE_SPACING_MS: "5m", OMB_ROUTINE_FAILURE_SPACING_MAX_MS: "1000" })).toEqual({ runs: 3, firstMs: HOUR, laterMs: 4 * HOUR });
    expect(failureSpacingLimits({ OMB_ROUTINE_FAILURE_SPACING_MS: "7200000", OMB_ROUTINE_FAILURE_SPACING_MAX_MS: "3600000" })).toMatchObject({ firstMs: 2 * HOUR, laterMs: 2 * HOUR });
  });
});

function harness(start?: RoutineManagerOptions["startTurn"], schedule: Parameters<RoutineManager["create"]>[0]["schedule"] = { type: "interval", everyMinutes: 5, anchorAt: START }) {
  const dir = mkdtempSync(join(tmpdir(), "omb-routine-failure-spacing-"));
  dirs.push(dir);
  let now = START, task = 0;
  const started: Array<{ threadId: string; prompt: string }> = [], alerts: unknown[] = [];
  const said = new Map<string, string[]>();
  const options: RoutineManagerOptions = {
    file: join(dir, "routines.json"), now: () => now, botState: () => "ready",
    createTask: () => ({ threadId: `thread-${++task}` }),
    startTurn: async (botId, threadId, prompt, ...rest) => { started.push({ threadId, prompt }); said.set(threadId, [...(said.get(threadId) ?? []), prompt]); await start?.(botId, threadId, prompt, ...rest); },
    promptSaid: (threadId, prompt) => said.get(threadId)?.includes(prompt) === true,
    onRunFailed: (_run, alert) => alerts.push(alert),
  };
  const manager = new RoutineManager(options);
  manager.create({ name: "Sync the CRM", prompt: "Read new leads from the CRM and file them", botId: "maus-1", schedule });
  const working = () => manager.listRuns().filter((run) => run.status === "running");
  return {
    manager, started, alerts,
    /** A scheduler pass every minute up to `to`; `settle` ends each turn the pass before left working. */
    passTo: async (to: number, settle: (run: RoutineRun) => void) => {
      while (now < to) {
        now += MINUTE;
        for (const run of working()) settle(run);
        await manager.tick();
      }
    },
    fail: (failure: string) => (run: RoutineRun) => manager.failThread(run.threadId!, failure),
    complete: (run: RoutineRun) => void manager.handleRuntimeEvent({ eventId: `done-${run.id}-${now}`, provider: "fake", threadId: run.threadId!, createdAt: new Date(now).toISOString(), type: "turn.completed", ok: true } as Parameters<RoutineManager["handleRuntimeEvent"]>[0]),
    rows: () => manager.listRuns().sort((a, b) => a.createdAt - b.createdAt),
    routine: () => manager.listRoutines()[0]!,
  };
}

describe("a routine every 5 minutes whose tool server is dead", () => {
  it("starts 9 turns in its first day instead of one or two every 5 minutes, stays on, and leaves one row for what it skipped", async () => {
    const h = harness();
    await h.passTo(START + 24 * HOUR, h.fail(DEAD_TOOL));
    console.log(`turns started in 24 hours with a dead tool server: ${h.started.length}`);
    expect(h.started).toHaveLength(9);
    expect(h.routine()).toMatchObject({ enabled: true });
    const skipped = h.rows().filter((run) => run.skipped);
    expect(skipped.every((run) => run.status === "missed" && /^Skipped \d+ scheduled runs because its last runs failed, so its next tries are spaced out$/.test(run.error!))).toBe(true);
    expect(skipped.reduce((sum, run) => sum + run.skipped!.count, 0) + h.started.length).toBe(24 * 12);
    expect(h.rows().filter((run) => run.status === "failed").every((run) => run.retried === undefined)).toBe(true);
    expect(h.alerts.filter((alert) => alert !== null && alert !== undefined)).toEqual([{ detail: expect.stringContaining("3 runs in a row failed. It stays on") }]);
  });

  it("goes back to every 5 minutes with the first run that completes", async () => {
    const h = harness();
    await h.passTo(START + 2 * HOUR, h.fail(DEAD_TOOL));
    const before = h.started.length;
    await h.passTo(START + 6 * HOUR, h.complete);
    await h.passTo(START + 7 * HOUR, h.complete);
    expect(h.started.length - before).toBeGreaterThanOrEqual(12);
    expect(h.rows().at(-2)).toMatchObject({ status: "completed" });
  });

  it("with the spacing set out of reach by OMB_ROUTINE_FAILURES_BEFORE_SPACING, starts one turn at every occurrence", async () => {
    // Six hours, not the day: the defaults would have spaced it out within the first. The clock is the harness's, so
    // nothing waits; the cost is real work per pass and per run, and a day of 288 runs took a Windows runner past 40 s.
    vi.stubEnv("OMB_ROUTINE_FAILURES_BEFORE_SPACING", "100000");
    const h = harness();
    await h.passTo(START + 6 * HOUR, h.fail(DEAD_TOOL));
    console.log(`turns started in 6 hours with a dead tool server and no spacing: ${h.started.length}`);
    expect(h.started).toHaveLength(6 * 12);
    expect(h.rows().filter((run) => run.skipped)).toEqual([]);
  });
});

describe("a routine every minute by cron whose tool server is dead", () => {
  it("is accepted, stays on, and is spaced out the same way", async () => {
    vi.stubEnv("OMB_ROUTINE_FAILURE_SPACING_MS", String(2 * MINUTE));
    vi.stubEnv("OMB_ROUTINE_FAILURE_SPACING_MAX_MS", String(4 * MINUTE));
    const h = harness(undefined, { type: "cron", expression: "* * * * *", timeZone: "UTC" });
    await h.passTo(START + 12 * MINUTE, h.fail(DEAD_TOOL));
    const startMinutes = h.rows().filter((run) => run.startedAt != null).map((run) => (run.scheduledFor - START) / MINUTE);
    expect(startMinutes).toEqual([1, 2, 3, 6, 11]);
    expect(h.routine()).toMatchObject({ enabled: true, schedule: { type: "cron", expression: "* * * * *" } });
  });
});

describe("a routine every 5 minutes on a server whose engines cannot start", () => {
  // Each of the 9 runs waits once for room and then fails with the refusal, instead of a spawn every 30 s for an hour.
  it("tries 9 runs in its first day, each started once more 30 s later for room and no more, never its retry", async () => {
    const h = harness(async () => { throw new Error(SPAWN_REFUSED); });
    await h.passTo(START + 24 * HOUR, () => {});
    console.log(`engine starts tried in 24 hours on a server that cannot start one: ${h.started.length}`);
    expect(h.started).toHaveLength(18);
    const perThread = new Map<string, number>();
    for (const turn of h.started) perThread.set(turn.threadId, (perThread.get(turn.threadId) ?? 0) + 1);
    expect([...perThread.values()]).toEqual(Array(9).fill(2));
    expect(h.routine()).toMatchObject({ enabled: true });
    expect(h.rows().filter((run) => run.status === "failed").every((run) => run.retried === undefined && run.error === SPAWN_REFUSED)).toBe(true);
  });
});

describe("a run's one second start", () => {
  it("is kept for a failure that passes, and sends only a short note when the conversation already holds the routine's instructions", async () => {
    const h = harness();
    await h.passTo(START + 5 * MINUTE, h.fail(OVERLOADED));
    await h.passTo(START + 7 * MINUTE, h.fail(OVERLOADED));
    expect(h.started.map((turn) => turn.threadId)).toEqual(["thread-1", "thread-1"]);
    const [first, second] = h.started;
    expect(first!.prompt).toContain("Read new leads from the CRM and file them");
    expect(second!.prompt).not.toContain("Read new leads from the CRM and file them");
    expect(second!.prompt).toContain("this run's first start failed on a temporary AI error before it finished");
    expect(second!.prompt).toContain("so nothing is done twice");
    console.log(`second start: ${second!.prompt.length} characters sent instead of ${first!.prompt.length + second!.prompt.length}`);
  });

  it("sends the routine's instructions again when the engine will not hold them: a backup AI, a usage-limit wait, a /command", () => {
    const said = () => true;
    expect(startPrompt({ retried: "provider" }, "Sync the CRM", "FIRST", said)).not.toContain("FIRST");
    expect(startPrompt({ retried: "usage_limit" }, "Sync the CRM", "FIRST", said)).toMatch(/^FIRST\n\n/);
    expect(startPrompt({ retried: "failed", attentionCode: "routines.server.backupSignedOut" }, "Sync the CRM", "FIRST", said)).toMatch(/^FIRST\n\n/);
    expect(startPrompt({ retried: "provider" }, "/weekly-report for the CRM", "FIRST", said)).toMatch(/^FIRST\n\n/);
    expect(startPrompt({ retried: "provider" }, "Sync the CRM", "FIRST", () => false)).toMatch(/^FIRST\n\n/);
  });

  it("counts the conversation as holding them only while a resumed session has them, or a replay's budget still reaches them", () => {
    const messages = [{ role: "user", text: "older" }, { role: "user", text: "FIRST" }, { role: "bot", text: "x".repeat(10_000) }];
    expect(sessionHolds({ resumes: true, messages, prompt: "FIRST", budgetBytes: 24_000 })).toBe(true);
    expect(sessionHolds({ resumes: false, messages, prompt: "FIRST", budgetBytes: 24_000 })).toBe(true);
    expect(sessionHolds({ resumes: false, messages: [...messages, { role: "bot", text: "y".repeat(20_000) }], prompt: "FIRST", budgetBytes: 24_000 })).toBe(false);
    expect(sessionHolds({ resumes: true, messages, prompt: "missing", budgetBytes: 24_000 })).toBe(false);
  });
});
