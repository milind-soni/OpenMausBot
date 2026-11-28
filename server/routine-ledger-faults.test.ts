// What the occurrence ledger promises under faults: every scheduled occurrence ends as ran, failed or missed with a
// reason, starts once, and shows in the health report's `schedule` section as the contract with the control plane says.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CATCH_UP_STAGGER_MS } from "./routine-catch-up.ts";
import { ledgerPaths, type Occurrence } from "./routine-ledger.ts";
import { LEASE_MS, UNRECORDED_START_PASSES } from "./routine-occurrences.ts";
import { TURN_GONE_MS } from "./routine-run-watch.ts";
import type { ScheduleSection } from "./routine-schedule-report.ts";
import { RoutineManager, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const START = Date.parse("2026-11-16T08:00:00Z");
const dirs: string[] = [];

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-routine-ledger-"));
  dirs.push(dir);
  return join(dir, "routines.json");
}

function harness(start = START, file = folder(), more: Partial<RoutineManagerOptions> = {}) {
  let now = start, bot: "ready" | "busy" | "missing" = "ready", task = 0, live: boolean | null = true;
  const started: string[] = [], prompts: string[] = [], failed: RoutineRun[] = [];
  const options: RoutineManagerOptions = {
    file, now: () => now, botState: () => bot, createTask: () => ({ threadId: `thread-${++task}` }),
    startTurn: async (_botId, threadId, prompt) => { started.push(threadId); prompts.push(prompt); },
    interruptTurn: async () => {}, onRunFailed: (run) => failed.push(run),
    // The fake turn is the working run's: an ended run's conversation is idle here.
    turnLive: (run) => (run.status === "running" || run.status === "waiting" ? live : false), ...more,
  };
  const h = {
    file, options, started, prompts, failed, manager: new RoutineManager(options),
    at: (value: number) => { now = value; }, now: () => now, bot: (value: typeof bot) => { bot = value; }, live: (value: boolean | null) => { live = value; },
    tickAt: async (value: number) => { now = value; await h.manager.tick(); },
    passTo: async (to: number, step = MINUTE) => { while (now + step <= to) { now += step; await h.manager.tick(); } if (now < to) { now = to; await h.manager.tick(); } },
    /** The process is killed and another starts on the same files: nothing of the first is flushed or given up. */
    kill: () => (h.manager = new RoutineManager(options)),
    /** A clean shutdown, then a start. */
    restart: () => { h.manager.close(); return (h.manager = new RoutineManager(options)); },
    event: (threadId: string, type: string, extra: Record<string, unknown> = {}) =>
      h.manager.handleRuntimeEvent({ eventId: `${type}-${threadId}-${now}`, provider: "fake", threadId, createdAt: new Date(now).toISOString(), type, ...extra } as Parameters<RoutineManager["handleRuntimeEvent"]>[0]),
    done: (threadId: string) => h.event(threadId, "turn.completed", { ok: true }),
    runs: () => h.manager.listRuns().sort((a, b) => a.createdAt - b.createdAt || a.scheduledFor - b.scheduledFor),
    routine: () => h.manager.listRoutines()[0]!,
    report: () => invariants(h.manager.scheduleReport(), now),
    records: (routineId = h.manager.listRoutines()[0]!.id) => h.manager.occurrences(routineId),
  };
  return h;
}

/** What the home must keep true in every report (the contract's rules that one report can show). */
function invariants(section: ScheduleSection, now: number): ScheduleSection {
  expect(section.v).toBe(1);
  expect(Number.isSafeInteger(section.seq) && section.seq >= 0).toBe(true);
  if (section.nextDueAt !== null && section.nextDueAt <= now) {
    expect(section.oldestUnconfirmed, "a past nextDueAt comes with the occurrence that has not started").not.toBeNull();
    expect(section.oldestUnconfirmed!.dueAt).toBeLessThanOrEqual(section.nextDueAt);
  }
  if (section.oldestUnconfirmed) expect(section.oldestUnconfirmed.dueAt).toBeLessThanOrEqual(now);
  if (section.lastConfirmed) expect(section.lastConfirmed.startedAt === null).toBe(section.lastConfirmed.state === "missed" || section.lastConfirmed.state === "skipped");
  if (section.unreadable) expect([section.nextDueAt, section.oldestUnconfirmed, section.lastConfirmed]).toEqual([null, null, null]);
  return section;
}

const every = (minutes: number, extra: Record<string, unknown> = {}) => ({ name: "Fix new bugs", prompt: "Look for new bug reports and fix them", botId: "maus-1",
  schedule: { type: "interval" as const, everyMinutes: minutes, anchorAt: START }, ...extra });
const NONE = { ran: 0, failed: 0, missed: 0, late: 0, retried: 0 };

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("an occurrence's record", () => {
  it("follows the run from due to queued to running to ran, and the report says each step", async () => {
    const h = harness();
    h.manager.create(every(60));
    expect(h.report()).toMatchObject({ unreadable: false, nextDueAt: START + HOUR, oldestUnconfirmed: null, lastConfirmed: null, due: { boot: NONE, day: NONE } });

    h.at(START + HOUR + 1_000);
    expect(h.report()).toMatchObject({ nextDueAt: START + HOUR, oldestUnconfirmed: { dueAt: START + HOUR, state: "due", since: START + HOUR }, lastConfirmed: null });

    h.bot("busy");
    await h.manager.tick();
    expect(h.records()).toMatchObject([{ dueAt: START + HOUR, state: "queued", attempts: 0 }]);
    expect(h.report()).toMatchObject({ nextDueAt: START + 2 * HOUR, oldestUnconfirmed: { dueAt: START + HOUR, state: "queued", since: START + HOUR + 1_000 }, lastConfirmed: null });

    h.bot("ready");
    await h.tickAt(START + HOUR + 7 * MINUTE);
    expect(h.started).toEqual(["thread-1"]);
    expect(h.records()).toMatchObject([{ state: "running", attempts: 1, startedAt: START + HOUR + 7 * MINUTE, runIds: [h.runs()[0]!.id] }]);
    expect(h.report()).toMatchObject({ oldestUnconfirmed: null, lastConfirmed: { dueAt: START + HOUR, startedAt: START + HOUR + 7 * MINUTE, state: "running" }, due: { boot: { ...NONE, late: 1 } } });

    h.done("thread-1");
    expect(h.records()).toMatchObject([{ state: "ran", attempts: 1, endedAt: START + HOUR + 7 * MINUTE }]);
    expect(h.records()[0]).not.toHaveProperty("lease");
    expect(h.report()).toMatchObject({ lastConfirmed: { dueAt: START + HOUR, state: "ran" }, due: { boot: { ...NONE, ran: 1, late: 1 }, day: { ...NONE, ran: 1, late: 1 } } });
  });

  it("is written before the turn starts, so the very next report names the run that started", async () => {
    const file = folder();
    let seen: ScheduleSection | undefined, onDisk = "";
    const h = harness(START, file, { startTurn: async () => { seen = h.manager.scheduleReport(); onDisk = readFileSync(ledgerPaths(file).ledger, "utf8"); } });
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    expect(seen).toMatchObject({ oldestUnconfirmed: null, lastConfirmed: { dueAt: START + HOUR, startedAt: START + HOUR, state: "running" } });
    expect(onDisk.trim().split("\n").map((line) => JSON.parse(line) as { o?: Occurrence }).findLast((line) => line.o)?.o).toMatchObject({ state: "running", attempts: 1 });
  });

  it("never holds a routine's name, prompt or output, in the file or in the report", async () => {
    const h = harness();
    const routine = h.manager.create(every(60, { name: "Quarterly-Secret-Plan", prompt: "Email payroll-figures to the board" }));
    await h.tickAt(START + HOUR);
    h.event("thread-1", "item.completed", { itemType: "assistant_text", text: "Sent payroll-figures to board@example.com" });
    h.done("thread-1");
    await h.tickAt(START + 2 * HOUR);
    h.manager.failThread("thread-2", "Provider said: payroll-figures rejected", { cause: "refused" });
    h.manager.close();
    const written = [readFileSync(ledgerPaths(h.file).ledger, "utf8"), readFileSync(ledgerPaths(h.file).mark, "utf8"), JSON.stringify(h.report())];
    for (const text of written) for (const secret of ["Quarterly", "payroll", "board@example.com", "Email", "Provider said", "maus-1", "thread-1"]) expect(text).not.toContain(secret);
    expect(written[2]).not.toContain(routine.id);
    for (const run of h.runs()) expect(written[2]).not.toContain(run.id);
    expect(JSON.stringify(h.report()).length).toBeLessThan(1_000);
  });
});

describe("a server killed in the middle of a run", () => {
  it("starts the occurrence again once, in the same conversation, and counts both starts on one record", async () => {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    const seq = h.report().seq;

    h.kill();
    expect(h.report().seq).toBeGreaterThanOrEqual(seq);
    expect(h.runs()).toMatchObject([{ status: "queued", retried: "restarted" }]);
    expect(h.report()).toMatchObject({ oldestUnconfirmed: null, lastConfirmed: { dueAt: START + HOUR, startedAt: START + HOUR, state: "running" } });
    await h.tickAt(START + HOUR + MINUTE);
    expect(h.started).toEqual(["thread-1", "thread-1"]);
    expect(h.prompts[1]).toContain("was cut off when OpenMausBot restarted");
    expect(h.records()).toMatchObject([{ dueAt: START + HOUR, state: "running", attempts: 2, startedAt: START + HOUR }]);
    expect(h.report().due.boot).toEqual({ ...NONE, retried: 1 });

    h.done("thread-1");
    await h.tickAt(START + HOUR + 2 * MINUTE);
    expect(h.started).toHaveLength(2);
    expect(h.records()).toMatchObject([{ state: "ran", attempts: 2 }]);
    expect(h.report().due.day).toEqual({ ...NONE, ran: 1, retried: 1 });
  });

  it("fails the occurrence once, with its reason, when the second start is cut too, and never starts it a third time", async () => {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    h.kill();
    await h.tickAt(START + HOUR + MINUTE);
    h.kill();
    expect(h.runs()).toMatchObject([{ status: "failed", error: "OpenMausBot restarted while this routine was running" }]);
    expect(h.records()).toMatchObject([{ state: "failed", attempts: 2, reason: "failed" }]);
    for (let minute = 2; minute < 60; minute += 5) await h.tickAt(START + HOUR + minute * MINUTE);
    expect(h.started).toEqual(["thread-1", "thread-1"]);
    expect(h.failed).toHaveLength(1);
    expect(h.report()).toMatchObject({ lastConfirmed: { dueAt: START + HOUR, state: "failed" }, due: { day: { ...NONE, failed: 1, retried: 1 } } });

    await h.tickAt(START + 2 * HOUR);
    expect(h.started).toEqual(["thread-1", "thread-1", "thread-2"]);
    expect(h.routine().enabled).toBe(true);
  });

  it("waits for another machine's lease to lapse before it starts a run that machine was running", async () => {
    const file = folder();
    const first = harness(START, file, { home: { machine: "machine-a" } });
    first.manager.create(every(60));
    await first.tickAt(START + HOUR);
    expect(first.records()[0]!.lease).toEqual({ machine: "machine-a", boot: expect.any(String), until: START + HOUR + LEASE_MS });

    const copy = harness(START + HOUR + 30_000, file, { home: { machine: "machine-b" } });
    expect(copy.runs()).toMatchObject([{ status: "queued", retried: "restarted", retryAt: START + HOUR + LEASE_MS + 1_000 }]);
    await copy.tickAt(START + HOUR + LEASE_MS);
    expect(copy.started).toEqual([]);
    await copy.tickAt(START + HOUR + LEASE_MS + 1_000);
    expect(copy.started).toEqual(["thread-1"]);

    const same = harness(START, folder(), { home: { machine: "machine-a" } });
    same.manager.create(every(60));
    await same.tickAt(START + HOUR);
    same.at(START + HOUR + 30_000);
    same.kill();
    expect(same.runs()).toMatchObject([{ status: "queued", retryAt: START + HOUR + 30_000 + 15_000 }]);
  });

  it("renews the lease while the run lives, and gives it up at a clean shutdown", async () => {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    const seq = h.report().seq;
    await h.passTo(START + HOUR + 10 * MINUTE);
    expect(h.records()[0]!.lease!.until).toBe(START + HOUR + 10 * MINUTE + LEASE_MS);
    expect(h.report().seq, "a renewed lease is no change to the report").toBe(seq);
    h.manager.close();
    expect(new RoutineManager(h.options).occurrences(h.routine().id)[0]).not.toHaveProperty("lease");
  });
});

describe("a computer asleep, or a server down, across due times", () => {
  it("runs the newest occurrence late and closes the ones before it on one row that counts them", async () => {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + 3 * HOUR + 20 * MINUTE);
    expect(h.started).toEqual(["thread-1"]);
    expect(h.runs().map((run) => [run.scheduledFor, run.status])).toEqual([[START + HOUR, "missed"], [START + 3 * HOUR, "running"]]);
    expect(h.runs()[0]).toMatchObject({ error: "Missed 2 scheduled runs because this computer was asleep or OpenMausBot was not running", errorCode: "routines.server.missedMany",
      errorParams: { count: 2, why: "routines.server.part.computerOff" }, skipped: { count: 2, firstAt: START + HOUR, lastAt: START + 2 * HOUR }, seenAt: START + 3 * HOUR + 20 * MINUTE });
    expect(h.failed).toEqual([]);
    expect(h.routine()).toMatchObject({ enabled: true, nextRunAt: START + 4 * HOUR });
    expect(h.records()).toMatchObject([
      { dueAt: START + 3 * HOUR, state: "running", attempts: 1 },
      { dueAt: START + HOUR, lastAt: START + 2 * HOUR, count: 2, state: "missed", reason: "computer-off", attempts: 0 },
    ]);
    expect(h.report()).toMatchObject({ nextDueAt: START + 4 * HOUR, oldestUnconfirmed: null, lastConfirmed: { dueAt: START + 3 * HOUR, state: "running" }, due: { boot: { ...NONE, missed: 2, late: 1 } } });
  });

  it("shows the overdue occurrence as due after a boot until the scheduler starts it, and never moves past it in silence", async () => {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    h.done("thread-1");
    h.manager.close();

    h.at(START + 2 * HOUR + 40 * MINUTE);
    h.kill();
    expect(h.report()).toMatchObject({ nextDueAt: START + 2 * HOUR, oldestUnconfirmed: { dueAt: START + 2 * HOUR, state: "due", since: START + 2 * HOUR }, lastConfirmed: { dueAt: START + HOUR, state: "ran" } });
    await h.manager.tick();
    expect(h.report()).toMatchObject({ nextDueAt: START + 3 * HOUR, oldestUnconfirmed: null, lastConfirmed: { dueAt: START + 2 * HOUR, startedAt: START + 2 * HOUR + 40 * MINUTE, state: "running" } });
  });

  it("closes every occurrence on one row the owner is told about when even the newest is more than 12 hours old", async () => {
    const h = harness();
    const daily = { name: "Morning report", prompt: "Write the morning report", botId: "maus-1", schedule: { type: "interval" as const, everyMinutes: 1_440, anchorAt: START } };
    h.manager.create(daily);
    await h.tickAt(START + 3 * DAY + 13 * HOUR);
    expect(h.started).toEqual([]);
    expect(h.runs()).toMatchObject([{ status: "missed", scheduledFor: START + DAY, error: "Missed 3 scheduled runs because this computer was asleep or OpenMausBot was not running",
      skipped: { count: 3, firstAt: START + DAY, lastAt: START + 3 * DAY, told: true } }]);
    expect(h.runs()[0]).not.toHaveProperty("seenAt");
    expect(h.failed).toHaveLength(1);
    expect(h.report()).toMatchObject({ nextDueAt: START + 4 * DAY, oldestUnconfirmed: null, lastConfirmed: { dueAt: START + 3 * DAY, startedAt: null, state: "missed" }, due: { boot: { ...NONE, missed: 3 } } });

    const once = harness();
    once.manager.create({ ...daily, schedule: { type: "once" as const, at: START + HOUR } });
    await once.tickAt(START + 14 * HOUR);
    expect(once.runs()).toMatchObject([{ status: "missed", error: "Missed because this computer was asleep or OpenMausBot was not running until more than 12 hours after its time" }]);
    expect(once.runs()[0]).not.toHaveProperty("skipped");
    expect(once.records()).toMatchObject([{ state: "missed", reason: "computer-off" }]);
  });

  it("says a Cloud home was asleep or restarting", async () => {
    const h = harness(START, folder(), { home: { cloud: true } });
    h.manager.create(every(60));
    await h.tickAt(START + 2 * HOUR + 20 * MINUTE);
    expect(h.runs()[0]).toMatchObject({ status: "missed", error: "Missed because this Cloud was asleep or restarting", skipped: { count: 1 } });
    expect(h.records().at(-1)).toMatchObject({ state: "missed", reason: "cloud-down" });
  });

  it("spreads the late starts of many routines out instead of starting them all in one second", async () => {
    const h = harness();
    for (const index of [0, 1, 2, 3]) h.manager.create(every(60, { name: `Routine ${index}`, botId: `maus-${index}` }));
    await h.tickAt(START + HOUR + 30 * MINUTE);
    expect(h.started).toHaveLength(1);
    expect(h.runs().map((run) => run.retryAt).sort()).toEqual([START + HOUR + 30 * MINUTE + CATCH_UP_STAGGER_MS, START + HOUR + 30 * MINUTE + 2 * CATCH_UP_STAGGER_MS, START + HOUR + 30 * MINUTE + 3 * CATCH_UP_STAGGER_MS, undefined]);
    expect(h.report()).toMatchObject({ oldestUnconfirmed: { dueAt: START + HOUR, state: "queued" } });
    await h.passTo(START + HOUR + 31 * MINUTE, CATCH_UP_STAGGER_MS);
    expect(h.started).toHaveLength(4);
    expect(h.report().oldestUnconfirmed).toBeNull();

    const onTime = harness();
    for (const index of [0, 1]) onTime.manager.create(every(60, { botId: `maus-${index}` }));
    await onTime.tickAt(START + HOUR);
    expect(onTime.started).toHaveLength(2);
  });

  it("counts occurrences that came due behind a run still at work on that run's row, the ones passed while asleep too", async () => {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    await h.tickAt(START + 4 * HOUR + 10 * MINUTE);
    expect(h.started).toEqual(["thread-1"]);
    expect(h.runs()[1]).toMatchObject({ status: "missed", skipped: { count: 3, firstAt: START + 2 * HOUR, lastAt: START + 4 * HOUR }, error: "Skipped 3 scheduled runs because the previous run of this routine is still running" });
    expect(h.routine().skippedRuns).toBe(3);
    expect(h.report()).toMatchObject({ oldestUnconfirmed: null, lastConfirmed: { dueAt: START + 4 * HOUR, startedAt: null, state: "skipped" } });
  });
});

describe("a clock that is set back or forward", () => {
  it("never starts an occurrence that already ran when the clock goes back before it", async () => {
    const h = harness();
    const routine = h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    h.done("thread-1");

    h.at(START + 30 * MINUTE);
    await h.manager.tick();
    expect(h.routine().nextRunAt).toBe(START + 2 * HOUR);
    // An edit made while the clock is back works the next run out again from the earlier time.
    h.manager.update(routine.id, { schedule: { type: "interval", everyMinutes: 60, anchorAt: START + HOUR } });
    expect(h.routine().nextRunAt).toBe(START + HOUR);
    await h.tickAt(START + HOUR);
    expect(h.started).toEqual(["thread-1"]);
    expect(h.routine().nextRunAt).toBe(START + 2 * HOUR);
    expect(h.records()).toMatchObject([{ dueAt: START + HOUR, state: "ran", attempts: 1 }]);
    expect(h.runs()).toHaveLength(1);
    await h.tickAt(START + 2 * HOUR);
    expect(h.started).toEqual(["thread-1", "thread-2"]);
  });

  it("runs what a clock set forward brings due, and nothing twice when it is set back", async () => {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + DAY + HOUR + MINUTE);
    expect(h.runs().map((run) => [run.scheduledFor, run.status])).toEqual([[START + HOUR, "missed"], [START + DAY + HOUR, "running"]]);
    expect(h.runs()[0]!.skipped).toMatchObject({ count: 24, firstAt: START + HOUR, lastAt: START + DAY });
    h.done("thread-1");
    const seq = h.report().seq;

    h.at(START + 2 * HOUR);
    for (let hour = 2; hour <= 25; hour += 1) await h.tickAt(START + hour * HOUR);
    expect(h.started).toEqual(["thread-1"]);
    expect(h.report().seq).toBeGreaterThanOrEqual(seq);
    await h.tickAt(START + DAY + 2 * HOUR);
    expect(h.started).toEqual(["thread-1", "thread-2"]);
  });
});

describe("a clock that was days ahead", () => {
  it("does not let the span it closed swallow the occurrences that come after the clock is put right", async () => {
    const h = harness();
    const routine = h.manager.create(every(60));
    await h.tickAt(START + 3 * DAY + 5 * MINUTE);
    h.done("thread-1");
    expect(h.runs()[0]!.skipped).toMatchObject({ firstAt: START + HOUR, lastAt: START + 3 * DAY - HOUR });

    h.at(START + 2 * HOUR + 10 * MINUTE);
    h.manager.update(routine.id, { name: "Fix the newest bugs" });
    h.manager.update(routine.id, { schedule: { type: "interval", everyMinutes: 60, anchorAt: START + 30 * MINUTE } });
    expect(h.routine().nextRunAt).toBe(START + 2 * HOUR + 30 * MINUTE);
    const span = h.records().find((record) => record.state === "missed")!;
    expect(span).toMatchObject({ dueAt: START + HOUR, cut: START + 2 * HOUR + 10 * MINUTE, endedAt: START + 2 * HOUR + 10 * MINUTE });
    expect(span.lastAt ?? span.dueAt).toBeLessThanOrEqual(START + 2 * HOUR + 10 * MINUTE);
    for (const half of [5, 7, 9]) await h.tickAt(START + half * 30 * MINUTE).then(() => h.done(`thread-${(half - 1) / 2}`));
    expect(h.started).toEqual(["thread-1", "thread-2", "thread-3", "thread-4"]);

    // Asked about only when the occurrence is already due, with nothing saved since the clock went back.
    const late = harness();
    late.manager.create(every(60));
    await late.tickAt(START + 3 * DAY + 5 * MINUTE);
    late.done("thread-1");
    late.manager.close();
    const saved = JSON.parse(readFileSync(late.file, "utf8")) as { routines: Array<Record<string, unknown>> };
    saved.routines[0]!.nextRunAt = START + 5 * HOUR;
    writeFileSync(late.file, JSON.stringify(saved));
    late.at(START + 5 * HOUR + MINUTE);
    late.kill();
    await late.manager.tick();
    expect(late.started).toEqual(["thread-1", "thread-2"]);
    late.done("thread-2");
    await late.tickAt(START + 6 * HOUR);
    expect(late.started).toEqual(["thread-1", "thread-2", "thread-3"]);
    expect(late.report().due.day.missed).toBeLessThanOrEqual(5);
  });
});

describe("a scheduler pass held up by another run's start", () => {
  it("says so for what it passed over, and does not count it as missed", async () => {
    const file = folder();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness(START, file, { startTurn: async (_botId, threadId) => { h.started.push(threadId); if (threadId === "thread-1") await gate; } });
    h.manager.create(every(24 * 60, { anchorAt: undefined, schedule: { type: "interval" as const, everyMinutes: 1_440, anchorAt: START + HOUR } }));
    h.manager.create(every(60, { name: "Half past", botId: "maus-2", schedule: { type: "interval" as const, everyMinutes: 60, anchorAt: START + 90 * MINUTE } }));
    h.at(START + HOUR);
    const held = h.manager.tick();
    h.at(START + 3 * HOUR + 40 * MINUTE);
    release();
    await held;
    await h.manager.tick();
    expect(h.started).toEqual(["thread-1", "thread-2"]);
    const passed = h.runs().find((run) => run.skipped)!;
    expect(passed).toMatchObject({ status: "missed", seenAt: START + 3 * HOUR + 40 * MINUTE, error: "Missed 2 scheduled runs because the scheduler was held up starting another run",
      skipped: { count: 2, firstAt: START + 90 * MINUTE, lastAt: START + 150 * MINUTE } });
    expect(h.records(passed.routineId).at(-1)).toMatchObject({ state: "skipped", reason: "scheduler-late" });
    expect(h.report().due).toMatchObject({ boot: { missed: 0, late: 1 }, day: { missed: 0 } });
  });
});

describe("a restore from a backup", () => {
  async function ranThreeTimes() {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    h.done("thread-1");
    return h;
  }
  const backup = (file: string) => { for (const path of [file, ledgerPaths(file).ledger]) copyFileSync(path, `${path}.backup`); };
  const restore = (file: string, ledger = true) => { for (const path of ledger ? [file, ledgerPaths(file).ledger] : [file]) copyFileSync(`${path}.backup`, path); };

  it("does not run again what ran after the backup was made, and reports a lower sequence number", async () => {
    const h = await ranThreeTimes();
    backup(h.file);
    await h.tickAt(START + 2 * HOUR);
    h.done("thread-2");
    await h.tickAt(START + 3 * HOUR);
    h.done("thread-3");
    const seq = h.report().seq;
    h.manager.close();

    restore(h.file);
    h.at(START + 3 * HOUR + 10 * MINUTE);
    h.kill();
    expect(h.report().seq).toBeLessThan(seq);
    expect(h.routine().nextRunAt).toBe(START + 4 * HOUR);
    await h.manager.tick();
    expect(h.started).toEqual(["thread-1", "thread-2", "thread-3"]);
    expect(h.runs().at(-1)).toMatchObject({ status: "missed", seenAt: START + 3 * HOUR + 10 * MINUTE, skipped: { count: 2, firstAt: START + 2 * HOUR, lastAt: START + 3 * HOUR },
      error: "Not run again: 2 scheduled runs from before this schedule was restored from a backup" });
    expect(h.records()[0]).toMatchObject({ dueAt: START + 2 * HOUR, lastAt: START + 3 * HOUR, state: "skipped", reason: "restored" });
    expect(h.failed).toEqual([]);

    h.kill();
    await h.tickAt(START + 4 * HOUR);
    expect(h.started).toEqual(["thread-1", "thread-2", "thread-3", "thread-4"]);
    expect(h.runs().filter((run) => run.skipped)).toHaveLength(1);
  });

  it("lets a run go that the backup held unfinished, and catches up what came due after the old schedule stopped", async () => {
    const h = await ranThreeTimes();
    await h.tickAt(START + 2 * HOUR);
    backup(h.file);
    h.done("thread-2");
    h.manager.close();

    restore(h.file);
    h.at(START + 5 * HOUR + 10 * MINUTE);
    h.kill();
    expect(h.runs().find((run) => run.scheduledFor === START + 2 * HOUR)).toMatchObject({ status: "cancelled", errorCode: "routines.server.restored" });
    await h.manager.tick();
    expect(h.started).toEqual(["thread-1", "thread-2", "thread-3"]);
    expect(h.runs().filter((run) => run.status === "missed").map((run) => run.skipped)).toMatchObject([{ count: 2, firstAt: START + 3 * HOUR, lastAt: START + 4 * HOUR }]);
    expect(h.runs().at(-1)).toMatchObject({ scheduledFor: START + 5 * HOUR, status: "running" });
  });

  it("with only routines.json put back, the ledger still knows what ran", async () => {
    const h = await ranThreeTimes();
    backup(h.file);
    await h.tickAt(START + 2 * HOUR);
    h.done("thread-2");
    const seq = h.report().seq;
    h.manager.close();

    restore(h.file, false);
    h.at(START + 2 * HOUR + MINUTE);
    h.kill();
    expect(h.routine().nextRunAt).toBe(START + 2 * HOUR);
    await h.manager.tick();
    expect(h.started).toEqual(["thread-1", "thread-2"]);
    expect(h.routine().nextRunAt).toBe(START + 3 * HOUR);
    expect(h.report().seq).toBeGreaterThanOrEqual(seq);
    expect(h.report()).toMatchObject({ oldestUnconfirmed: null, lastConfirmed: { dueAt: START + 2 * HOUR, state: "ran" } });
  });
});

describe("two scheduler passes at once", () => {
  it("start an occurrence once when they overlap in one process", async () => {
    const file = folder();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness(START, file, { startTurn: async (_botId, threadId) => { h.started.push(threadId); await gate; } });
    h.manager.create(every(60));
    h.at(START + HOUR);
    const passes = [h.manager.tick(), h.manager.tick(), h.manager.tick()];
    release();
    await Promise.all(passes);
    await h.manager.tick();
    expect(h.started).toEqual(["thread-1"]);
    expect(h.runs()).toHaveLength(1);
  });

  it("start an occurrence once when two processes hold the same files", async () => {
    const file = folder();
    const first = harness(START, file);
    first.manager.create(every(60));
    const second = harness(START, file);
    await first.tickAt(START + HOUR);
    await second.tickAt(START + HOUR);
    expect([first.started, second.started]).toEqual([["thread-1"], []]);
    expect(second.routine().nextRunAt).toBe(START + 2 * HOUR);
    expect(second.runs()).toEqual([]);

    // The second gets there first, while the first is still held up behind a busy bot.
    first.done("thread-1");
    first.bot("busy");
    await first.tickAt(START + 2 * HOUR);
    await second.tickAt(START + 2 * HOUR);
    first.bot("ready");
    await first.tickAt(START + 2 * HOUR + MINUTE);
    expect([first.started, second.started]).toEqual([["thread-1"], ["thread-1"]]);
    expect(first.runs().at(-1)).toMatchObject({ status: "cancelled", error: "Not started: this scheduled run had already started once" });
  });
});

describe("a run whose turn is gone", () => {
  it("is started again once the host has said so for five minutes of passes, then failed with its reason", async () => {
    const h = harness();
    h.manager.create(every(24 * 60));
    await h.tickAt(START + DAY);
    h.live(false);
    await h.passTo(START + DAY + 4 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running" }]);
    h.event("thread-1", "item.completed", { itemType: "assistant_text", text: "Still working" });
    await h.passTo(START + DAY + 8 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running" }]);
    await h.passTo(START + DAY + 4 * MINUTE + TURN_GONE_MS + MINUTE);
    expect(h.runs()).toMatchObject([{ status: "queued", retried: "failed", attention: "Starting again shortly after a failure: its turn ended without reporting back" }]);

    await h.passTo(START + DAY + 12 * MINUTE);
    expect(h.started).toEqual(["thread-1", "thread-1"]);
    await h.passTo(START + DAY + 20 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "failed", error: "Failed after one automatic retry: its turn ended without reporting back" }]);
    expect(h.records()).toMatchObject([{ state: "failed", attempts: 2, reason: "turn-gone" }]);
    expect(h.failed).toHaveLength(1);
    await h.passTo(START + DAY + HOUR);
    expect(h.started).toHaveLength(2);
    expect(h.routine().enabled).toBe(true);
  });

  it("is left alone while it waits on the person, while the host cannot tell, and across a sleep", async () => {
    const h = harness();
    h.manager.create(every(24 * 60));
    await h.tickAt(START + DAY);
    h.event("thread-1", "request.opened", { requestId: "ask-1", requestType: "question", tool: "ask", summary: "Which branch?" });
    h.live(false);
    await h.passTo(START + DAY + 30 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "waiting" }]);
    h.event("thread-1", "request.resolved", { requestId: "ask-1", source: "user" });

    h.live(null);
    await h.passTo(START + DAY + HOUR);
    expect(h.runs()).toMatchObject([{ status: "running" }]);

    h.live(false);
    await h.manager.tick();
    await h.tickAt(START + DAY + 9 * HOUR);
    await h.tickAt(START + DAY + 9 * HOUR + MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running" }]);
  });
});

describe("a run that waits on the person for more than a day", () => {
  it("keeps showing as started, hides no occurrence that has not, and gives way to the next occurrence", async () => {
    const h = harness();
    h.manager.create(every(24 * 60));
    await h.tickAt(START + DAY);
    h.event("thread-1", "request.opened", { requestId: "ask-1", requestType: "question", tool: "ask", summary: "Which branch?" });
    await h.passTo(START + DAY + 23 * HOUR, HOUR);
    expect(h.report()).toMatchObject({ nextDueAt: START + 2 * DAY, oldestUnconfirmed: null, lastConfirmed: { dueAt: START + DAY, startedAt: START + DAY, state: "running" } });

    await h.tickAt(START + 2 * DAY + MINUTE);
    expect(h.runs().map((run) => run.status)).toEqual(["cancelled", "running"]);
    expect(h.runs()[0]!.error).toBe("Stopped waiting: the next scheduled run of this routine started instead");
    expect(h.records()).toMatchObject([{ dueAt: START + 2 * DAY, state: "running" }, { dueAt: START + DAY, state: "failed", reason: "superseded", attempts: 1 }]);
    expect(h.report()).toMatchObject({ lastConfirmed: { dueAt: START + 2 * DAY, state: "running" }, due: { boot: { ...NONE, failed: 1 } } });
  });
});

describe("retries that run out", () => {
  it("fail the occurrence once after its one automatic retry, keep the routine on, and run the next occurrence", async () => {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    h.manager.failThread("thread-1", "The engine process exited");
    expect(h.runs()).toMatchObject([{ status: "queued", retried: "failed" }]);
    expect(h.report()).toMatchObject({ oldestUnconfirmed: null, lastConfirmed: { dueAt: START + HOUR, state: "running" } });
    await h.tickAt(START + HOUR + MINUTE);
    h.manager.failThread("thread-1", "The engine process exited");
    expect(h.runs()).toMatchObject([{ status: "failed", error: "Failed after one automatic retry: The engine process exited" }]);
    expect(h.records()).toMatchObject([{ state: "failed", attempts: 2, reason: "failed", startedAt: START + HOUR }]);
    expect(h.report()).toMatchObject({ lastConfirmed: { dueAt: START + HOUR, startedAt: START + HOUR, state: "failed" }, due: { boot: { ...NONE, failed: 1, retried: 1 }, day: { ...NONE, failed: 1, retried: 1 } } });
    await h.tickAt(START + 2 * HOUR);
    expect(h.started).toEqual(["thread-1", "thread-1", "thread-2"]);
    expect(h.routine().enabled).toBe(true);
  });

  it("does not count a start the bot refused as busy, and gives the occurrence up as missed after an hour of that", async () => {
    const file = folder();
    const h = harness(START, file, { startTurn: async () => { throw Object.assign(new Error("This conversation is busy"), { code: "thread_busy" }); } });
    h.manager.create(every(24 * 60));
    await h.tickAt(START + DAY);
    await h.passTo(START + DAY + 59 * MINUTE);
    expect(h.records()).toMatchObject([{ state: "queued", attempts: 0 }]);
    expect(h.records()[0]).not.toHaveProperty("startedAt");
    expect(h.report()).toMatchObject({ oldestUnconfirmed: { dueAt: START + DAY, state: "queued" }, due: { boot: NONE } });
    await h.passTo(START + DAY + 62 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "failed" }]);
    expect(h.records()).toMatchObject([{ state: "missed", attempts: 0, reason: "bot-busy" }]);
    expect(h.report()).toMatchObject({ oldestUnconfirmed: null, lastConfirmed: { dueAt: START + DAY, startedAt: null, state: "missed" } });
  });
});

describe("the files", () => {
  const rows = (count: number, routineId: string): RoutineRun[] => Array.from({ length: count }, (_, index) => ({
    id: `run-${index}`, routineId, routineName: "Fix new bugs", target: "bot" as const, botId: "maus-1", runOn: "maus" as const, scheduledFor: START - (count - index) * 5 * MINUTE,
    status: index % 50 === 7 ? "failed" as const : index % 50 === 9 ? "missed" as const : "completed" as const, manual: index % 100 === 3, triggerSource: index % 100 === 3 ? "manual" as const : "schedule" as const,
    createdAt: START - (count - index) * 5 * MINUTE, ...(index % 50 === 9 ? {} : { startedAt: START - (count - index) * 5 * MINUTE + 1_000 }),
    finishedAt: START - (count - index) * 5 * MINUTE + 60_000, ...(index % 50 === 7 ? { error: "Provider crashed", retried: "failed" as const } : {}),
  }));

  it("makes the ledger from a routines.json of 2,000 run rows written before there was one, losing none of them", async () => {
    const file = folder();
    const seed = harness(START - DAY, file);
    const routine = seed.manager.create(every(5));
    seed.manager.close();
    for (const path of Object.values(ledgerPaths(file))) rmSync(path, { force: true });
    const saved = JSON.parse(readFileSync(file, "utf8")) as { routines: Array<Record<string, unknown>>; runs: RoutineRun[] };
    saved.runs = rows(2_000, routine.id);
    saved.routines[0]!.nextRunAt = START;
    writeFileSync(file, JSON.stringify(saved));

    const h = harness(START - 1_000, file);
    expect(h.runs()).toHaveLength(2_000);
    const scheduled = saved.runs.filter((run) => !run.manual);
    expect(h.records()).toHaveLength(scheduled.length);
    expect(h.records().filter((record) => record.state === "failed")).toHaveLength(40);
    expect(h.records().find((record) => record.state === "failed")).toMatchObject({ attempts: 2, reason: "failed" });
    expect(h.records().filter((record) => record.state === "missed")).toHaveLength(40);
    expect(h.records().find((record) => record.state === "missed")).toMatchObject({ attempts: 0, reason: "not-started" });
    expect(h.report()).toMatchObject({ nextDueAt: START, oldestUnconfirmed: null, lastConfirmed: { dueAt: START - 5 * MINUTE, startedAt: START - 5 * MINUTE + 1_000, state: "ran" } });
    const lastDay = scheduled.filter((run) => run.finishedAt! > START - 1_000 - DAY), ended = (status: RoutineRun["status"]) => lastDay.filter((run) => run.status === status).length;
    expect(lastDay.length).toBeGreaterThan(280);
    expect(h.report().due.day).toEqual({ ran: ended("completed"), failed: ended("failed"), missed: ended("missed"), late: 0, retried: ended("failed") });
    expect(h.report().due.boot).toEqual(NONE);

    await h.tickAt(START);
    expect(h.started).toEqual(["thread-1"]);
    expect(h.runs()).toHaveLength(2_000);
    const seq = h.report().seq;
    expect(new RoutineManager(h.options).scheduleReport().seq).toBeGreaterThanOrEqual(seq);
  });

  it("leaves routines.json as an earlier version reads it, and works again after that version ran without the ledger", async () => {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    h.done("thread-1");
    h.manager.close();
    const saved = JSON.parse(readFileSync(h.file, "utf8")) as Record<string, unknown> & { routines: Array<Record<string, unknown>>; runs: RoutineRun[] };
    expect(Object.keys(saved).sort()).toEqual(["frozenResultsCleared", "routineRequestReceipts", "routines", "runs", "version", "webhookRunReceipts"]);
    expect(saved).toMatchObject({ version: 1, routines: [{ enabled: true, nextRunAt: START + 2 * HOUR }], runs: [{ status: "completed", scheduledFor: START + HOUR }] });

    // The earlier version runs the next occurrence and saves routines.json, knowing nothing of the ledger.
    saved.runs.push({ ...saved.runs[0]!, id: "made-by-the-earlier-version", scheduledFor: START + 2 * HOUR, createdAt: START + 2 * HOUR, startedAt: START + 2 * HOUR, finishedAt: START + 2 * HOUR + MINUTE });
    saved.routines[0]!.nextRunAt = START + 3 * HOUR;
    writeFileSync(h.file, JSON.stringify(saved));

    h.at(START + 2 * HOUR + 30 * MINUTE);
    h.kill();
    expect(h.manager.listRoutines()).toHaveLength(1);
    expect(h.records()).toMatchObject([{ dueAt: START + 2 * HOUR, state: "ran", attempts: 1 }, { dueAt: START + HOUR, state: "ran" }]);
    await h.tickAt(START + 3 * HOUR);
    expect(h.started).toEqual(["thread-1", "thread-2"]);
  });

  it("writes nothing when a start finds nothing changed", async () => {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    h.done("thread-1");
    h.manager.close();
    const { ledger, mark } = ledgerPaths(h.file), before = [readFileSync(h.file, "utf8"), readFileSync(ledger, "utf8"), readFileSync(mark, "utf8")];
    h.at(START + HOUR + 10 * MINUTE);
    h.kill();
    h.report();
    h.manager.close();
    expect([readFileSync(h.file, "utf8"), readFileSync(ledger, "utf8"), readFileSync(mark, "utf8")]).toEqual(before);
  });

  it("keeps what can be read of a ledger with a torn or damaged line, and never lowers the sequence number when the ledger is lost", async () => {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    h.done("thread-1");
    const seq = h.report().seq, { ledger, mark } = ledgerPaths(h.file);
    h.manager.close();

    writeFileSync(ledger, `${readFileSync(ledger, "utf8")}{"s":${seq + 1},"o":{"routineId":"torn`);
    h.kill();
    expect(h.records()).toMatchObject([{ dueAt: START + HOUR, state: "ran" }]);
    expect(h.report().seq).toBeGreaterThanOrEqual(seq);
    await h.tickAt(START + 2 * HOUR);
    expect(h.started).toEqual(["thread-1", "thread-2"]);
    h.done("thread-2");
    const after = h.report().seq;
    h.manager.close();
    expect(new RoutineManager(h.options).occurrences(h.routine().id)).toMatchObject([{ dueAt: START + 2 * HOUR, state: "ran" }, { dueAt: START + HOUR, state: "ran" }]);

    rmSync(ledger);
    h.kill();
    expect(existsSync(mark)).toBe(true);
    expect(h.report().seq).toBeGreaterThan(after);
    expect(h.records()).toMatchObject([{ dueAt: START + 2 * HOUR, state: "ran" }, { dueAt: START + HOUR, state: "ran" }]);
    await h.tickAt(START + 3 * HOUR);
    expect(h.started).toEqual(["thread-1", "thread-2", "thread-3"]);
  });

  it("says so in the report while routines.json cannot be read, with a sequence number that moved", async () => {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    h.done("thread-1");
    const seq = h.report().seq;
    h.manager.close();
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(h.file, "{ not json");
    h.kill();
    const unreadable = h.report();
    expect(unreadable).toMatchObject({ unreadable: true, nextDueAt: null, oldestUnconfirmed: null, lastConfirmed: null });
    expect(unreadable.seq).toBeGreaterThan(seq);
    expect(h.report().seq).toBe(unreadable.seq);
  });

  it("holds a start back a few passes for a ledger that cannot be written, then runs without it, and never stops another run or a save", async () => {
    const h = harness();
    const hourly = h.manager.create(every(60));
    const other = h.manager.create(every(24 * 60, { name: "Weekly digest", botId: "maus-2" }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ledger } = ledgerPaths(h.file);
    // A folder where the file should be: every append fails, on Windows as on any other system.
    rmSync(ledger);
    mkdirSync(ledger);

    await h.tickAt(START + HOUR);
    expect(h.started).toEqual([]);
    h.manager.runNow(other.id);
    for (let pass = 1; pass <= UNRECORDED_START_PASSES - 1; pass += 1) await h.tickAt(START + HOUR + pass * 10_000);
    expect(h.started, "the run someone started by hand does not wait behind it").toEqual(["thread-1"]);
    expect(h.report().unreadable).toBe(false);
    await h.tickAt(START + HOUR + UNRECORDED_START_PASSES * 10_000);
    expect(h.started).toEqual(["thread-1", "thread-2"]);
    expect(h.report()).toMatchObject({ unreadable: true, nextDueAt: null, oldestUnconfirmed: null, lastConfirmed: null });

    h.done("thread-1");
    h.done("thread-2");
    const saved = () => (JSON.parse(readFileSync(h.file, "utf8")) as { runs: RoutineRun[] }).runs.map((run) => run.status).sort();
    expect(saved()).toEqual(["completed", "completed"]);
    for (let hour = 2; hour <= 6; hour += 1) {
      await h.tickAt(START + hour * HOUR);
      h.done(`thread-${hour + 1}`);
    }
    expect(h.started).toHaveLength(7);
    expect(saved().filter((status) => status === "completed")).toHaveLength(7);
    expect(h.failed).toEqual([]);

    // A process that starts while the ledger is still unwritable loads, picks a cut run up and saves its end.
    await h.tickAt(START + 7 * HOUR);
    h.kill();
    expect(h.runs().at(-1)).toMatchObject({ status: "queued", retried: "restarted" });
    for (let pass = 1; pass <= UNRECORDED_START_PASSES + 1; pass += 1) await h.tickAt(START + 7 * HOUR + pass * 20_000);
    expect(h.started.at(-1)).toBe("thread-8");
    h.event("thread-8", "turn.started");
    h.done("thread-8");
    expect(saved().filter((status) => status === "completed")).toHaveLength(8);

    rmSync(ledger, { recursive: true });
    await h.tickAt(START + 8 * HOUR);
    expect(h.report()).toMatchObject({ unreadable: false, lastConfirmed: { dueAt: START + 8 * HOUR, state: "running" } });
    expect(h.records(hourly.id).filter((record) => record.state === "ran")).toHaveLength(7);
  });

  it("makes an empty ledger again from the rows, and takes it for no restore", async () => {
    const h = harness();
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    h.done("thread-1");
    h.bot("busy");
    await h.tickAt(START + 2 * HOUR);
    h.manager.close();
    writeFileSync(ledgerPaths(h.file).ledger, "");
    h.at(START + 2 * HOUR + MINUTE);
    h.kill();
    expect(h.runs().map((run) => run.status)).toEqual(["completed", "queued"]);
    expect(h.records()).toMatchObject([{ dueAt: START + 2 * HOUR, state: "queued" }, { dueAt: START + HOUR, state: "ran" }]);
    h.bot("ready");
    await h.manager.tick();
    expect(h.started).toEqual(["thread-1", "thread-2"]);
  });
});
