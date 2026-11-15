// What a schedule may count on: failures never turn a routine off, nothing holds it up without end, every occurrence
// that does not run leaves a row, and a routines.json that cannot be read is kept, reported and read again.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SCHEDULER_STOP_WAIT_MS, STOP_CONFIRM_WAIT_MS } from "./routine-bounds.ts";
import { UNREADABLE_RETRY_MS } from "./routine-file.ts";
import { RoutineManager, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const START = Date.parse("2026-11-16T08:00:00Z");
const NO_START = "Maus's cloud desktop didn't start. Change where this routine runs.";
const dirs: string[] = [];

function harness(start = START, file?: string) {
  let now = start, bot: "ready" | "busy" | "missing" = "ready", task = 0;
  if (!file) { const dir = mkdtempSync(join(tmpdir(), "omb-routine-reliability-")); dirs.push(dir); file = join(dir, "routines.json"); }
  const started: string[] = [], interrupted: string[] = [], emitted: Array<Record<string, unknown>> = [], changed: RoutineRun[] = [];
  const failed: Array<{ run: RoutineRun; alert: unknown }> = [], deferred: RoutineRun[] = [];
  const options: RoutineManagerOptions = {
    file, now: () => now, emit: (payload) => emitted.push(payload), botState: () => bot,
    createTask: () => ({ threadId: `thread-${++task}` }),
    startTurn: async (_botId, threadId) => { started.push(threadId); },
    interruptTurn: async (_botId, threadId) => { interrupted.push(threadId); },
    onRunChanged: (run) => changed.push(run), onRunFailed: (run, alert) => failed.push({ run, alert }), onRunDeferred: (run) => deferred.push(run),
  };
  const h = {
    file, options, started, interrupted, emitted, changed, failed, deferred, manager: new RoutineManager(options),
    at: (value: number) => { now = value; }, bot: (value: typeof bot) => { bot = value; },
    tickAt: async (value: number) => { now = value; await h.manager.tick(); },
    /** A scheduler pass every `step` up to `to`, as the running scheduler makes while a run works or waits to start. */
    passTo: async (to: number, step = MINUTE) => { while (now + step <= to) { now += step; await h.manager.tick(); } if (now < to) { now = to; await h.manager.tick(); } },
    /** The process ends and another starts on the same file: the first one's scheduler does nothing more. */
    restart: () => { h.manager.close(); return (h.manager = new RoutineManager(options)); },
    event: (threadId: string, type: string, more: Record<string, unknown> = {}) =>
      h.manager.handleRuntimeEvent({ eventId: `${type}-${threadId}`, provider: "fake", threadId, createdAt: new Date(now).toISOString(), type, ...more } as Parameters<RoutineManager["handleRuntimeEvent"]>[0]),
    done: (threadId: string) => h.event(threadId, "turn.completed", { ok: true }),
    runs: () => h.manager.listRuns().sort((a, b) => a.createdAt - b.createdAt || a.scheduledFor - b.scheduledFor),
    routine: () => h.manager.listRoutines()[0]!,
    disk: () => JSON.parse(readFileSync(file!, "utf8")) as { routines: Array<Record<string, unknown>>; runs: RoutineRun[] },
  };
  return h;
}

const every = (minutes: number, more: Record<string, unknown> = {}) => ({ name: "Fix new bugs", prompt: "Look for new bug reports and fix them", botId: "maus-1",
  schedule: { type: "interval" as const, everyMinutes: minutes, anchorAt: START }, ...more });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a routine whose runs fail", () => {
  it("stays on through three cloud-computer start failures in a row, and runs its next occurrence once the computer works", async () => {
    const h = harness();
    h.manager.create(every(24 * 60));
    for (const day of [1, 2, 3]) {
      await h.tickAt(START + day * 24 * HOUR);
      h.manager.failThread(`thread-${day}`, NO_START, { cause: "refused" });
      expect(h.routine()).toMatchObject({ enabled: true, nextRunAt: START + (day + 1) * 24 * HOUR });
    }
    expect(h.routine()).toMatchObject({ enabled: true, failureStreak: 3, noStartStreak: 3 });
    expect(h.failed.map((failure) => failure.alert)).toEqual([undefined, null, { detail: expect.stringContaining("3 runs in a row failed this way. It stays on") }]);

    await h.tickAt(START + 4 * 24 * HOUR);
    expect(h.started).toEqual(["thread-1", "thread-2", "thread-3", "thread-4"]);
    h.done("thread-4");
    expect(h.runs().map((run) => run.status)).toEqual(["failed", "failed", "failed", "completed"]);
    expect(h.routine()).toMatchObject({ enabled: true, nextRunAt: START + 5 * 24 * HOUR });
    expect(h.routine()).not.toHaveProperty("noStartStreak");
    expect(h.restart().listRoutines()[0]).toMatchObject({ enabled: true, nextRunAt: START + 5 * 24 * HOUR });
  });

  it("spaces a frequent routine's tries instead of starting one every few minutes, on one row, and starts again by itself", async () => {
    const h = harness();
    h.manager.create(every(5));
    for (const turn of [1, 2, 3]) {
      await h.tickAt(START + turn * 5 * MINUTE);
      h.manager.failThread(`thread-${turn}`, NO_START, { cause: "refused" });
    }
    const failedAt = START + 15 * MINUTE;
    for (let minute = 20; minute <= 70; minute += 5) await h.tickAt(START + minute * MINUTE);
    expect(h.started).toHaveLength(3);
    expect(h.routine()).toMatchObject({ enabled: true, noStartStreak: 3, skippedRuns: 11 });
    const held = h.runs().filter((run) => run.skipped);
    expect(held).toMatchObject([{ status: "missed", error: "Skipped 11 scheduled runs because its cloud desktop has not started, so its next tries are spaced out",
      skipped: { count: 11, firstAt: START + 20 * MINUTE, lastAt: START + 70 * MINUTE }, seenAt: START + 20 * MINUTE }]);
    expect(h.failed).toHaveLength(3);

    await h.tickAt(failedAt + HOUR);
    expect(h.started).toHaveLength(4);
    h.manager.failThread("thread-4", NO_START, { cause: "refused" });
    await h.tickAt(failedAt + HOUR + 3 * HOUR + 55 * MINUTE);
    expect(h.started).toHaveLength(4);
    await h.tickAt(failedAt + HOUR + 4 * HOUR);
    expect(h.started).toHaveLength(5);
    h.done("thread-5");
    await h.tickAt(failedAt + HOUR + 4 * HOUR + 5 * MINUTE);
    expect(h.started).toHaveLength(6);
    expect(h.routine()).not.toHaveProperty("noStartStreak");
  });

  it("lets the person start a run by hand, or change the routine, while its tries are spaced out", async () => {
    const h = harness();
    const routine = h.manager.create(every(5));
    for (const turn of [1, 2, 3]) {
      await h.tickAt(START + turn * 5 * MINUTE);
      h.manager.failThread(`thread-${turn}`, NO_START, { cause: "refused" });
    }
    h.manager.runNow(routine.id); await h.tickAt(START + 16 * MINUTE);
    expect(h.started).toHaveLength(4);
    h.manager.failThread("thread-4", NO_START, { cause: "refused" });
    await h.tickAt(START + 20 * MINUTE);
    expect(h.started).toHaveLength(4);
    h.manager.update(routine.id, { prompt: "Look for new bug reports, fix them, and say what changed" });
    await h.tickAt(START + 25 * MINUTE);
    expect(h.started).toHaveLength(5);
  });

  it("counts failures in a row from the saved rows, so a restart between two failures hides neither", async () => {
    const h = harness();
    const routine = h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    h.manager.failThread("thread-1", "The bot did not complete this run", { cause: "refused" });
    expect(h.manager.health(100)).toEqual([{ routineId: routine.id, status: "failed", at: START + HOUR, consecutiveFailures: 1 }]);
    h.restart();
    expect(h.manager.health(100)).toEqual([{ routineId: routine.id, status: "failed", at: START + HOUR, consecutiveFailures: 1 }]);
    await h.tickAt(START + 2 * HOUR);
    h.manager.failThread("thread-2", "The bot did not complete this run", { cause: "refused" });
    h.restart();
    expect(h.manager.health(100)).toEqual([{ routineId: routine.id, status: "failed", at: START + 2 * HOUR, consecutiveFailures: 2 }]);
    expect(h.routine().failureStreak).toBe(2);
    await h.tickAt(START + 3 * HOUR);
    h.done("thread-3");
    expect(h.manager.health(100)).toEqual([{ routineId: routine.id, status: "completed", at: START + 3 * HOUR, consecutiveFailures: 0 }]);
  });
});

describe("routines an earlier version turned off after three cloud-computer start failures", () => {
  const saved = (id: string, more: Record<string, unknown> = {}) => ({ id, ...every(60), target: "bot", runOn: "maus", durationMinutes: 30, enabled: false, nextRunAt: null, createdAt: START, updatedAt: START + 3 * HOUR + 50, ...more });
  const failures = (routineId: string) => [1, 2, 3].map((hour): RoutineRun => ({ id: `${routineId}-${hour}`, routineId, routineName: "Fix new bugs", target: "bot", botId: "maus-1", runOn: "maus",
    scheduledFor: START + hour * HOUR, status: "failed", manual: false, error: NO_START, createdAt: START + hour * HOUR, startedAt: START + hour * HOUR, finishedAt: START + hour * HOUR + 50 }));

  it("come back on at the next start, and only those: one a person paused, one changed since and one held stay as they are", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-routine-reliability-")); dirs.push(dir);
    const file = join(dir, "routines.json");
    const routines = [saved("switched-off"), saved("paused-by-person", { updatedAt: START + 5 * HOUR }), saved("renamed-since", { name: "Renamed", updatedAt: START + 4 * HOUR }),
      saved("held", { heldFor: "no_connections" }), saved("on", { enabled: true, nextRunAt: START + 9 * HOUR })];
    writeFileSync(file, JSON.stringify({ version: 1, routines, runs: routines.flatMap((routine) => failures(routine.id)) }));
    const h = harness(START + 7 * HOUR + 10 * MINUTE, file);
    const after = Object.fromEntries(h.manager.listRoutines().map((routine) => [routine.id, routine]));
    expect(after["switched-off"]).toMatchObject({ enabled: true, nextRunAt: START + 8 * HOUR, updatedAt: START + 7 * HOUR + 10 * MINUTE });
    expect(after["switched-off"]).not.toHaveProperty("noStartStreak");
    expect(after["paused-by-person"]).toMatchObject({ enabled: false, nextRunAt: null, updatedAt: START + 5 * HOUR });
    expect(after["renamed-since"]).toMatchObject({ enabled: false, nextRunAt: null, updatedAt: START + 4 * HOUR });
    expect(after.held).toMatchObject({ enabled: false, heldFor: "no_connections", updatedAt: START + 3 * HOUR + 50 });
    expect(after.on).toMatchObject({ enabled: true, nextRunAt: START + 9 * HOUR });
    expect(h.manager.takeTurnedBackOn().map((routine) => [routine.id, routine.botId, routine.name])).toEqual([["switched-off", "maus-1", "Fix new bugs"]]);
    expect(h.manager.takeTurnedBackOn()).toEqual([]);
  });

  it("are looked for once per install: a later start turns nothing back on, even one that matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-routine-reliability-")); dirs.push(dir);
    const file = join(dir, "routines.json");
    writeFileSync(file, JSON.stringify({ version: 1, routines: [saved("switched-off")], runs: failures("switched-off") }));
    const h = harness(START + 7 * HOUR, file);
    expect(h.routine().enabled).toBe(true);
    h.manager.close();
    const disk = JSON.parse(readFileSync(file, "utf8"));
    expect(disk.noStartOffsChecked).toBe(true);
    // The same shape again, as a copy of an older file dropped into place would give it.
    writeFileSync(file, JSON.stringify({ ...disk, routines: [saved("switched-off")], runs: failures("switched-off") }));
    h.manager = new RoutineManager(h.options);
    expect(h.routine()).toMatchObject({ enabled: false, nextRunAt: null, updatedAt: START + 3 * HOUR + 50 });
    expect(h.manager.takeTurnedBackOn()).toEqual([]);
    h.manager.update("switched-off", { enabled: true });
    expect(h.disk()).toMatchObject({ noStartOffsChecked: true });
  });

  it("are left alone while this copy is frozen by a move, and looked for at the first start after the freeze lifts", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-routine-reliability-")); dirs.push(dir);
    const file = join(dir, "routines.json");
    writeFileSync(file, JSON.stringify({ version: 1, routines: [saved("switched-off")], runs: failures("switched-off") }));
    const h = harness(START + 7 * HOUR, file);
    let frozen = true;
    h.options.moveFrozen = () => frozen;
    h.restart();
    // The first manager, made before the option was set, did the look: put the file back as the frozen copy holds it.
    h.manager.close();
    writeFileSync(file, JSON.stringify({ version: 1, routines: [saved("switched-off")], runs: failures("switched-off") }));
    h.manager = new RoutineManager(h.options);
    expect(h.routine()).toMatchObject({ enabled: false });
    expect(h.manager.takeTurnedBackOn()).toEqual([]);
    h.manager.markAllSeen();
    expect(h.disk()).not.toHaveProperty("noStartOffsChecked");
    frozen = false;
    expect(h.restart().listRoutines()[0]).toMatchObject({ enabled: true });
  });

  it("stay off when the switch-off is more than thirty days old, or when a workspace restore has stamped them since", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-routine-reliability-")); dirs.push(dir);
    const file = join(dir, "routines.json");
    writeFileSync(file, JSON.stringify({ version: 1, routines: [saved("old")], runs: failures("old") }));
    expect(harness(START + 3 * HOUR + 31 * 24 * HOUR, file).routine()).toMatchObject({ enabled: false });
    const restoredAt = START + 2 * 24 * HOUR;
    writeFileSync(file, JSON.stringify({ version: 1, routines: [saved("restored", { updatedAt: restoredAt })], runs: failures("restored") }));
    const h = harness(restoredAt + HOUR, file);
    expect(h.routine()).toMatchObject({ enabled: false, updatedAt: restoredAt });
    expect(h.manager.takeTurnedBackOn()).toEqual([]);
  });

  it("run their next occurrence, stay on across another start, and stay off once the person turns them off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-routine-reliability-")); dirs.push(dir);
    const file = join(dir, "routines.json");
    writeFileSync(file, JSON.stringify({ version: 1, routines: [saved("switched-off")], runs: failures("switched-off") }));
    const h = harness(START + 7 * HOUR + 10 * MINUTE, file);
    await h.tickAt(START + 8 * HOUR);
    expect(h.started).toEqual(["thread-1"]);
    h.done("thread-1");
    expect(h.disk().routines[0]).toMatchObject({ enabled: true });
    h.manager.update("switched-off", { enabled: false });
    expect(h.restart().listRoutines()[0]).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it("wait under the cause that holds every routine, and come back when it ends", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-routine-reliability-")); dirs.push(dir);
    const file = join(dir, "routines.json");
    writeFileSync(file, JSON.stringify({ version: 1, routines: [saved("switched-off")], runs: failures("switched-off"), holds: ["no_connections"] }));
    const h = harness(START + 7 * HOUR + 10 * MINUTE, file);
    expect(h.routine()).toMatchObject({ enabled: false, heldFor: "no_connections" });
    expect(h.manager.takeTurnedBackOn()).toEqual([]);
    h.manager.holdFor([]);
    expect(h.routine()).toMatchObject({ enabled: true, nextRunAt: START + 8 * HOUR });
    expect(h.routine()).not.toHaveProperty("heldFor");
  });
});

describe("a row that only counts skipped occurrences", () => {
  it("is no failure: one failed run and an overlap skip read as one failure in health, and the week counts real runs only", async () => {
    const h = harness();
    const routine = h.manager.create(every(5));
    await h.tickAt(START + 5 * MINUTE);
    await h.tickAt(START + 10 * MINUTE);
    h.manager.failThread("thread-1", "The bot did not complete this run", { cause: "refused" });
    expect(h.runs().map((run) => [run.status, run.skipped?.count])).toEqual([["failed", undefined], ["missed", 1]]);
    expect(h.manager.health(100)).toEqual([{ routineId: routine.id, status: "failed", at: START + 10 * MINUTE, consecutiveFailures: 1 }]);
    expect(h.routine()).toMatchObject({ failureStreak: 1, weekRuns: { ok: 0, total: 1 } });
  });

  it("leaves a routine whose runs always overlap the next occurrence healthy: every run OK, newest result completed", async () => {
    const h = harness();
    const routine = h.manager.create(every(5));
    for (let turn = 1; turn <= 4; turn += 1) {
      await h.tickAt(START + (turn * 10 - 5) * MINUTE);
      await h.tickAt(START + turn * 10 * MINUTE);
      h.done(`thread-${turn}`);
    }
    expect(h.runs().filter((run) => run.skipped)).toHaveLength(4);
    expect(h.manager.health(100)).toEqual([{ routineId: routine.id, status: "completed", at: START + 40 * MINUTE, consecutiveFailures: 0 }]);
    expect(h.routine()).toMatchObject({ weekRuns: { ok: 4, total: 4 } });
    expect(h.routine()).not.toHaveProperty("failureStreak");
  });

  it("still counts when the owner was told: a run that waited past the notice window is a result", async () => {
    const h = harness();
    h.options.hasPendingDelegations = () => true; h.options.handedOffWorkLive = () => true;
    const routine = h.manager.create(every(5));
    await h.tickAt(START + 5 * MINUTE);
    h.done("thread-1");
    for (let minute = 10; minute <= 40; minute += 5) await h.tickAt(START + minute * MINUTE);
    expect(h.runs().filter((run) => run.skipped)).toMatchObject([{ skipped: { told: true } }]);
    expect(h.manager.health(100)).toEqual([{ routineId: routine.id, status: "missed", at: START + 40 * MINUTE, consecutiveFailures: 1 }]);
    expect(h.routine()).toMatchObject({ weekRuns: { ok: 0, total: 1 } });
  });
});

describe("a spaced routine and a home that sleeps", () => {
  it("reports its next due time as the first occurrence after the spacing, so nothing wakes or waits for runs it will skip", async () => {
    const h = harness();
    h.manager.create(every(5));
    expect(h.manager.nextDueAt()).toBe(START + 5 * MINUTE);
    for (const turn of [1, 2, 3]) {
      await h.tickAt(START + turn * 5 * MINUTE);
      h.manager.failThread(`thread-${turn}`, NO_START, { cause: "refused" });
    }
    expect(h.routine().nextRunAt).toBe(START + 20 * MINUTE);
    expect(h.manager.nextDueAt()).toBe(START + 75 * MINUTE);
    expect(h.manager.wakeHold(30 * MINUTE)).toEqual({ hold: false });
    await h.tickAt(START + 20 * MINUTE);
    expect(h.manager.nextDueAt()).toBe(START + 75 * MINUTE);
    await h.tickAt(START + 76 * MINUTE);
    expect(h.started).toHaveLength(4);
    h.done("thread-4");
    expect(h.manager.nextDueAt()).toBe(START + 80 * MINUTE);
  });
});

describe("deliberate pauses still hold", () => {
  it("keeps a routine the person paused off, and one held because its owner left off until the cause ends", async () => {
    const h = harness();
    const paused = h.manager.create(every(60, { name: "Paused by hand" }));
    const held = h.manager.create(every(60, { name: "Held" }));
    h.manager.update(paused.id, { enabled: false });
    expect(h.manager.holdFor(["no_connections"])).toEqual(["no_connections"]);
    await h.tickAt(START + 2 * HOUR);
    expect(h.started).toEqual([]);
    const after = h.restart().listRoutines();
    expect(after.find((routine) => routine.id === paused.id)).toMatchObject({ enabled: false });
    expect(after.find((routine) => routine.id === paused.id)).not.toHaveProperty("heldFor");
    expect(after.find((routine) => routine.id === held.id)).toMatchObject({ enabled: false, heldFor: "no_connections" });
    h.manager.holdFor([]);
    expect(h.manager.listRoutines().map((routine) => [routine.name, routine.enabled]).sort()).toEqual([["Held", true], ["Paused by hand", false]]);
  });

  it("lets a bot the person paused drop its scheduled runs quietly", async () => {
    const h = harness();
    h.options.pausedText = () => "Maus is paused, so it takes no new work."; h.options.held = () => true;
    h.manager.create(every(60));
    await h.tickAt(START + HOUR);
    expect(h.runs().map((run) => [run.status, run.error])).toEqual([["cancelled", "Maus is paused, so it takes no new work."]]);
    expect([h.started, h.failed]).toEqual([[], []]);
    expect(h.routine().enabled).toBe(true);
  });
});

describe("a run queued behind a busy bot", () => {
  it("ends as missed after an hour of that wait, with the reason, and the schedule carries on", async () => {
    const h = harness(); h.bot("busy");
    h.manager.create(every(120));
    const due = START + 2 * HOUR;
    await h.tickAt(due);
    await h.passTo(due + 59 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "queued", deferredAt: due, busyMs: 59 * MINUTE }]);
    expect(h.deferred).toHaveLength(1);
    await h.passTo(due + HOUR);
    expect(h.runs()).toMatchObject([{ status: "missed", finishedAt: due + HOUR, error: "Did not run: the bot was busy for more than 60 minutes",
      errorCode: "routines.server.busyTooLong", errorParams: { minutes: 60 } }]);
    expect(h.failed.map((failure) => [failure.run.status, failure.alert])).toEqual([["missed", undefined]]);
    expect(h.routine()).toMatchObject({ enabled: true, nextRunAt: START + 4 * HOUR });

    h.bot("ready");
    await h.tickAt(START + 4 * HOUR);
    expect(h.started).toEqual(["thread-1"]);
    expect(h.runs().map((run) => run.status)).toEqual(["missed", "running"]);
  });

  it("counts only the time it was seen busy: not the time the process was down, nor the hours the computer slept", async () => {
    const h = harness(); h.bot("busy");
    h.manager.create(every(24 * 60));
    const due = START + 24 * HOUR;
    await h.tickAt(due);
    await h.passTo(due + 30 * MINUTE);
    h.at(due + 5 * HOUR); h.restart();
    expect(h.runs()).toMatchObject([{ status: "queued", busyMs: 30 * MINUTE }]);
    await h.tickAt(due + 5 * HOUR);
    await h.passTo(due + 5 * HOUR + 10 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "queued", busyMs: 40 * MINUTE }]);
    await h.tickAt(due + 13 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "queued", busyMs: 42 * MINUTE }]);
    await h.passTo(due + 13 * HOUR + 18 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "missed" }]);
  });

  it("forgets the wait once the run starts: a run that waited, started, and is queued again hours later is not missed at once", async () => {
    const h = harness(); h.bot("busy");
    h.manager.create({ ...every(60), schedule: { type: "once", at: START + HOUR } });
    await h.tickAt(START + HOUR);
    await h.passTo(START + HOUR + 50 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "queued", busyMs: 50 * MINUTE }]);
    h.bot("ready");
    await h.tickAt(START + HOUR + 51 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running" }]);
    expect(h.runs()[0]).not.toHaveProperty("busyMs");
    expect(h.disk().runs[0]).not.toHaveProperty("busyMs");

    h.at(START + 4 * HOUR);
    h.event("thread-1", "runtime.error", { message: "The AI service is overloaded (529)" });
    h.event("thread-1", "turn.completed", { ok: false, stopReason: "error" });
    expect(h.runs()).toMatchObject([{ status: "queued", retried: "provider" }]);
    h.bot("busy");
    await h.tickAt(START + 4 * HOUR + MINUTE);
    await h.passTo(START + 4 * HOUR + 30 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "queued", busyMs: 29 * MINUTE }]);
    h.bot("ready");
    await h.tickAt(START + 4 * HOUR + 31 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running" }]);
    expect(h.failed).toEqual([]);
  });

  it("keeps an event's run and a run started by hand waiting as long as it takes: nothing comes after them", async () => {
    const h = harness(); h.bot("busy");
    const routine = h.manager.create(every(24 * 60));
    h.manager.enqueueWebhook({ webhookId: "hook", webhookName: "New lead", prompt: "Handle it", botId: "maus-1", runOn: "maus", deliveryId: "d1", receivedAt: START });
    h.manager.runNow(routine.id);
    await h.tickAt(START + MINUTE);
    await h.passTo(START + 3 * HOUR);
    expect(h.runs().map((run) => [run.triggerSource, run.status, run.busyMs])).toEqual([["webhook", "queued", undefined], ["manual", "queued", undefined]]);
    expect(h.failed).toEqual([]);
    h.bot("ready");
    await h.tickAt(START + 3 * HOUR + MINUTE);
    expect(h.started).toHaveLength(2);
  });

  it("does not give up a run queued behind its own routine's earlier run", async () => {
    const h = harness();
    h.manager.create(every(30, { overlap: "queue" }));
    await h.tickAt(START + 30 * MINUTE);
    await h.passTo(START + 150 * MINUTE);
    expect(h.runs().filter((run) => !run.skipped).map((run) => [run.status, run.busyMs])).toEqual([["running", undefined], ["queued", undefined]]);
    h.done("thread-1");
    await h.tickAt(START + 151 * MINUTE);
    expect(h.started).toEqual(["thread-1", "thread-2"]);
  });
});

describe("a run held until its cloud computer is ready", () => {
  it("is asked for only once its bot is free, adds nothing to the busy wait while it is held, and starts when the computer answers", async () => {
    const h = harness(); h.bot("busy");
    const asked: number[] = [];
    let ready: (reason: string | null) => void = () => {};
    h.options.preparing = "Waiting for its cloud computer to wake and answer";
    h.options.prepareRun = () => { asked.push(1); return new Promise((resolve) => { ready = resolve; }); };
    h.manager.create(every(24 * 60));
    const due = START + 24 * HOUR;
    await h.tickAt(due);
    await h.passTo(due + 20 * MINUTE);
    expect(asked).toEqual([]);
    expect(h.runs()).toMatchObject([{ status: "queued", busyMs: 20 * MINUTE }]);
    h.bot("ready");
    await h.passTo(due + 3 * HOUR);
    expect(asked).toEqual([1]);
    expect(h.runs()).toMatchObject([{ status: "queued", busyMs: 20 * MINUTE, attention: "Waiting for its cloud computer to wake and answer" }]);
    expect(h.failed).toEqual([]);
    ready(null);
    await new Promise((resolve) => setImmediate(resolve));
    await h.tickAt(due + 3 * HOUR + MINUTE);
    expect(h.started).toEqual(["thread-1"]);
    expect(h.runs()[0]).not.toHaveProperty("busyMs");
  });

  it("fails with the computer's reason when it is not ready, which never spaces the routine out: its next occurrence tries again", async () => {
    const h = harness();
    const reason = "The cloud computer did not answer in time, so this run did not start. The next scheduled run tries again.";
    h.options.prepareRun = () => Promise.resolve(reason);
    h.manager.create(every(5));
    for (const turn of [1, 2, 3, 4]) {
      await h.tickAt(START + turn * 5 * MINUTE);
      await new Promise((resolve) => setImmediate(resolve));
      await h.manager.tick();
    }
    expect(h.runs().map((run) => [run.status, run.error])).toEqual(Array(4).fill(["failed", reason]));
    expect(h.routine()).toMatchObject({ enabled: true, failureStreak: 4, nextRunAt: START + 25 * MINUTE });
    expect(h.routine()).not.toHaveProperty("noStartStreak");
    expect(h.manager.nextDueAt()).toBe(START + 25 * MINUTE);
    expect(h.started).toEqual([]);
  });
});

describe("occurrences that land while an earlier run of the routine is going", () => {
  it("leave one missed row for the whole run, with their count and first and last time, and are shown as already seen", async () => {
    const h = harness();
    h.manager.create(every(5));
    await h.tickAt(START + 5 * MINUTE);
    for (let minute = 10; minute <= 170; minute += 5) await h.tickAt(START + minute * MINUTE);
    const [running, skipped, ...rest] = h.runs();
    expect(rest).toEqual([]);
    expect(running).toMatchObject({ status: "running", threadId: "thread-1" });
    expect(skipped).toMatchObject({ status: "missed", scheduledFor: START + 10 * MINUTE, finishedAt: START + 170 * MINUTE, seenAt: START + 10 * MINUTE,
      error: "Skipped 33 scheduled runs because the previous run of this routine is still running",
      skipped: { count: 33, firstAt: START + 10 * MINUTE, lastAt: START + 170 * MINUTE, behind: running!.id } });
    expect(h.failed).toEqual([]);
    expect(h.changed.filter((run) => run.id === skipped!.id)).toEqual([]);
    expect(h.emitted.filter((frame) => frame.kind === "routine.run" && (frame.run as RoutineRun).id === skipped!.id)).toHaveLength(33);
    expect(h.routine()).toMatchObject({ skippedRuns: 33, lastSkippedAt: START + 170 * MINUTE });
    expect(h.disk().runs.find((run) => run.id === skipped!.id)?.skipped).toMatchObject({ count: 33 });

    h.done("thread-1");
    await h.tickAt(START + 175 * MINUTE);
    await h.tickAt(START + 180 * MINUTE);
    expect(h.runs().map((run) => [run.status, run.skipped?.count])).toEqual([["completed", undefined], ["missed", 33], ["running", undefined], ["missed", 1]]);
  });

  it("keeps the count across a restart", async () => {
    const h = harness();
    h.options.hasPendingDelegations = () => true;
    h.manager.create(every(5));
    await h.tickAt(START + 5 * MINUTE);
    h.done("thread-1");
    await h.tickAt(START + 10 * MINUTE);
    h.restart();
    await h.tickAt(START + 15 * MINUTE);
    expect(h.runs().filter((run) => run.skipped)).toMatchObject([{ skipped: { count: 2, firstAt: START + 10 * MINUTE, lastAt: START + 15 * MINUTE } }]);
  });
});

describe("the default run limit", () => {
  it("stops a run after three hours of work, fails it with the reason, and starts the next occurrence", async () => {
    const h = harness();
    h.manager.create(every(240));
    const due = START + 4 * HOUR;
    await h.tickAt(due);
    await h.passTo(due + 3 * HOUR - MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running", workedMs: 3 * HOUR - MINUTE }]);
    await h.passTo(due + 3 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "failed", finishedAt: due + 3 * HOUR, error: "Stopped: this run ran longer than the 3-hour limit", errorCode: "routines.server.overLimit", errorParams: { hours: 3 } }]);
    expect(h.interrupted).toEqual(["thread-1"]);
    expect(h.failed.map((failure) => failure.run.error)).toEqual(["Stopped: this run ran longer than the 3-hour limit"]);
    expect(h.routine()).toMatchObject({ enabled: true, nextRunAt: START + 8 * HOUR });
    expect(h.event("thread-1", "turn.completed", { ok: false, stopReason: "interrupted" })).toBeNull();
    await h.tickAt(START + 8 * HOUR);
    expect(h.started).toEqual(["thread-1", "thread-2"]);
    expect(h.runs().map((run) => run.status)).toEqual(["failed", "running"]);
  });

  it("does not fail a run for the hours the computer slept, or for a clock that jumped", async () => {
    const h = harness();
    h.manager.create({ ...every(60), schedule: { type: "once", at: START + HOUR } });
    const due = START + HOUR;
    await h.tickAt(due);
    await h.passTo(due + 30 * MINUTE);
    // The lid closes for nine hours: on wake one pass sees the whole gap.
    await h.tickAt(due + 30 * MINUTE + 9 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "running", workedMs: 32 * MINUTE }]);
    // The clock is set back a day, then forward again.
    await h.tickAt(due - 24 * HOUR);
    await h.tickAt(due + 30 * MINUTE + 9 * HOUR + MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running", workedMs: 34 * MINUTE }]);
    expect(h.failed).toEqual([]);
    await h.passTo(due + 30 * MINUTE + 9 * HOUR + MINUTE + 146 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "failed", error: "Stopped: this run ran longer than the 3-hour limit" }]);
  });

  it("does not count the time an approval or question is open, nor a wait on work handed on", async () => {
    const h = harness();
    let handedOn = false;
    h.options.hasPendingDelegations = () => handedOn;
    h.manager.create({ ...every(60), schedule: { type: "once", at: START + HOUR } });
    const due = START + HOUR;
    await h.tickAt(due);
    await h.passTo(due + HOUR);
    h.event("thread-1", "request.opened", { requestType: "question", tool: "ask", summary: "Which repository?" });
    await h.passTo(due + 11 * HOUR, 10 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "waiting", workedMs: HOUR }]);
    h.event("thread-1", "request.resolved", { behavior: "answer", source: "user" });
    await h.passTo(due + 12 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "running", workedMs: 2 * HOUR }]);
    handedOn = true; h.done("thread-1");
    expect(h.runs()).toMatchObject([{ status: "waiting", waitingSince: due + 12 * HOUR }]);
    await h.passTo(due + 40 * HOUR, 30 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "waiting", workedMs: 2 * HOUR }]);
    h.event("thread-1", "turn.started");
    await h.passTo(due + 41 * HOUR - MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running", workedMs: 3 * HOUR - MINUTE }]);
    await h.passTo(due + 41 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "failed", error: "Stopped: this run ran longer than the 3-hour limit" }]);
  });

  it("keeps the work of a run that waits across a restart, and counts on when it goes back to work", async () => {
    const h = harness();
    h.options.hasPendingDelegations = () => true;
    h.manager.create({ ...every(60), schedule: { type: "once", at: START + HOUR } });
    await h.tickAt(START + HOUR);
    await h.passTo(START + 3 * HOUR);
    h.done("thread-1");
    h.at(START + 30 * HOUR); h.restart();
    expect(h.runs()).toMatchObject([{ status: "waiting", workedMs: 2 * HOUR }]);
    h.event("thread-1", "turn.started");
    await h.passTo(START + 31 * HOUR - MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running" }]);
    await h.passTo(START + 31 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "failed", error: "Stopped: this run ran longer than the 3-hour limit" }]);
  });

  it("does not count the time a run is queued, and starts its count afresh at each start", async () => {
    const h = harness(); h.bot("busy");
    h.manager.create({ ...every(60), schedule: { type: "once", at: START + HOUR } });
    await h.tickAt(START + HOUR);
    await h.passTo(START + HOUR + 50 * MINUTE);
    h.bot("ready");
    await h.passTo(START + 3 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "running", startedAt: START + HOUR + 51 * MINUTE, workedMs: 69 * MINUTE }]);
    h.event("thread-1", "runtime.error", { message: "The AI service is overloaded (529)" });
    h.event("thread-1", "turn.completed", { ok: false, stopReason: "error" });
    expect(h.runs()).toMatchObject([{ status: "queued", retried: "provider" }]);
    await h.passTo(START + 3 * HOUR + MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running", startedAt: START + 3 * HOUR + MINUTE }]);
    expect(h.runs()[0]!.workedMs ?? 0).toBe(0);
    await h.passTo(START + 6 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "running" }]);
    await h.passTo(START + 6 * HOUR + MINUTE);
    expect(h.runs()).toMatchObject([{ status: "failed" }]);
  });

  it("gives a room goal's run twelve hours, and names that limit when it stops it", async () => {
    const h = harness();
    const goals: Array<{ threadId: string; outcome?: unknown }> = [];
    h.options.goalState = () => "ready"; h.options.createGoalTask = () => ({ threadId: "goal-thread-1" }); h.options.startGoal = async () => {};
    h.options.interruptGoal = async (_groupId, threadId, outcome) => { goals.push({ threadId, outcome }); };
    h.manager.create({ ...every(60), name: "Team goal", target: "room-goal", botId: "chief-1", groupId: "room-1", schedule: { type: "once", at: START + HOUR } });
    await h.tickAt(START + HOUR);
    await h.passTo(START + 13 * HOUR - MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running", target: "room-goal", workedMs: 12 * HOUR - MINUTE }]);
    await h.passTo(START + 13 * HOUR);
    expect(h.runs()).toMatchObject([{ status: "failed", goalStatus: "limit-reached", error: "Stopped: this run ran longer than the 12-hour limit", errorParams: { hours: 12 } }]);
    expect(goals).toEqual([{ threadId: "goal-thread-1", outcome: { status: "limit-reached", detail: "Stopped: this run ran longer than the 12-hour limit" } }]);
  });

  it("applies to an event's run and to a run started by hand, and gives way to a routine's own limit of up to a day", async () => {
    const h = harness();
    const own = h.manager.create(every(24 * 60, { name: "Long build", timeoutMinutes: 1_440 }));
    expect(() => h.manager.update(own.id, { timeoutMinutes: 1_441 })).toThrow("from 5 to 1440 minutes");
    h.manager.enqueueWebhook({ webhookId: "hook", webhookName: "New lead", prompt: "Handle it", botId: "maus-2", runOn: "maus", deliveryId: "d1", receivedAt: START });
    await h.tickAt(START + MINUTE);
    h.manager.runNow(own.id);
    await h.tickAt(START + 2 * MINUTE);
    await h.passTo(START + 3 * HOUR + MINUTE);
    expect(h.runs().map((run) => [run.triggerSource, run.status])).toEqual([["webhook", "failed"], ["manual", "running"]]);
    await h.passTo(START + 24 * HOUR + MINUTE);
    expect(h.runs().find((run) => run.manual)).toMatchObject({ status: "running" });
    await h.passTo(START + 24 * HOUR + 2 * MINUTE);
    expect(h.runs().find((run) => run.manual)).toMatchObject({ status: "failed", error: "Stopped after reaching the 1440-minute run limit" });
  });

  it("wakes the scheduler each minute while a run works, with no other work due, and stops it at the limit", async () => {
    vi.useFakeTimers({ now: START });
    const h = harness();
    h.options.now = () => Date.now();
    h.restart();
    h.manager.create({ ...every(60), schedule: { type: "once", at: START + MINUTE } });
    h.manager.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running" }]);
    await vi.advanceTimersByTimeAsync(3 * HOUR - MINUTE);
    expect(h.runs()).toMatchObject([{ status: "running" }]);
    expect(h.runs()[0]!.workedMs).toBeGreaterThan(2 * HOUR + 55 * MINUTE);
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(h.runs()).toMatchObject([{ status: "failed", error: "Stopped: this run ran longer than the 3-hour limit" }]);
    h.manager.stop();
  });
});

describe("a turn that does not stop", () => {
  const hung = () => {
    vi.useFakeTimers({ now: START });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    const stops: string[] = [];
    h.options.now = () => Date.now();
    h.options.interruptTurn = (_botId, threadId) => { stops.push(threadId); return new Promise<void>(() => {}); };
    h.restart();
    /** A pass that waits out a stop that never answers. */
    const pass = async () => { const done = h.manager.tick(); await vi.advanceTimersByTimeAsync(SCHEDULER_STOP_WAIT_MS); await done; };
    return { h, stops, warn, pass };
  };

  it("holds the scheduler ten seconds, then the other routines fire", async () => {
    const { h, warn } = hung();
    h.manager.create(every(240, { name: "Runs too long", timeoutMinutes: 30 }));
    h.manager.create(every(270, { name: "Must still fire", botId: "maus-2" }));
    vi.setSystemTime(START + 4 * HOUR); await h.manager.tick();
    expect(h.started).toEqual(["thread-1"]);

    vi.setSystemTime(START + 4 * HOUR + 30 * MINUTE);
    let finished = false;
    const pass = h.manager.tick().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(SCHEDULER_STOP_WAIT_MS - 1);
    expect([finished, h.manager.isTicking, h.started.length]).toEqual([false, true, 1]);
    await vi.advanceTimersByTimeAsync(1);
    await pass;
    expect([finished, h.manager.isTicking]).toEqual([true, false]);
    expect(h.started).toEqual(["thread-1", "thread-2"]);
    expect(h.runs().map((run) => [run.routineName, run.status])).toEqual([["Runs too long", "failed"], ["Must still fire", "running"]]);
    expect(h.manager.schedulerState()).toEqual({ unreadable: false, slowStops: 1 });
    expect(warn.mock.calls.flat().join(" ")).toContain("did not finish in 10 s");
  });

  it("starts no new run of that routine while the stop is outstanding, sends the stop again, and says so on the row", async () => {
    const { h, stops, pass } = hung();
    const routine = h.manager.create(every(60, { timeoutMinutes: 30 }));
    vi.setSystemTime(START + HOUR); await h.manager.tick();
    vi.setSystemTime(START + HOUR + 30 * MINUTE); await pass();
    expect(h.runs()).toMatchObject([{ status: "failed", error: "Stopped after reaching the 30-minute run limit", attentionCode: "routines.server.stopPending",
      attention: "Its turn has not confirmed that it stopped. The next run waits for that, up to 5 minutes." }]);
    expect(stops).toEqual(["thread-1"]);

    // Its next occurrence comes due, and the person presses Run now: neither starts beside the turn that may still be running.
    vi.setSystemTime(START + HOUR + 30 * MINUTE + 30_000);
    h.manager.runNow(routine.id); await h.manager.tick();
    expect(h.started).toEqual(["thread-1"]);
    vi.setSystemTime(START + HOUR + 31 * MINUTE + 15_000); await pass();
    expect(stops).toEqual(["thread-1", "thread-1"]);
    expect(h.started).toEqual(["thread-1"]);
    expect(h.runs().at(-1)).toMatchObject({ status: "queued", manual: true });
    expect(h.runs().at(-1)).not.toHaveProperty("busyMs");

    // The turn's end arrives: the stop is confirmed, the mark goes, and the waiting run starts.
    h.event("thread-1", "turn.completed", { ok: false, stopReason: "interrupted" });
    expect(h.runs()[0]).toMatchObject({ status: "failed", error: "Stopped after reaching the 30-minute run limit" });
    expect(h.runs()[0]!.attention).toBeUndefined();
    await h.manager.tick();
    expect(h.started).toEqual(["thread-1", "thread-2"]);
  });

  it("stops waiting after five minutes, starts the next run, and leaves the row saying the stop was never confirmed", async () => {
    const { h, pass } = hung();
    h.manager.create(every(60, { timeoutMinutes: 55 }));
    vi.setSystemTime(START + HOUR); await h.manager.tick();
    vi.setSystemTime(START + HOUR + 55 * MINUTE); await pass();
    vi.setSystemTime(START + 2 * HOUR); await pass();
    expect(h.started).toEqual(["thread-1"]);
    expect(h.runs().filter((run) => !run.skipped).map((run) => run.status)).toEqual(["failed", "queued"]);
    vi.setSystemTime(START + HOUR + 55 * MINUTE + STOP_CONFIRM_WAIT_MS + SCHEDULER_STOP_WAIT_MS); await pass();
    expect(h.started).toEqual(["thread-1", "thread-2"]);
    expect(h.runs()[0]).toMatchObject({ status: "failed", attentionCode: "routines.server.stopUnconfirmed", attention: "Its turn never confirmed that it stopped, so the next run started without that." });
    expect(h.disk().runs[0]).toMatchObject({ attentionCode: "routines.server.stopUnconfirmed" });
  });

  it("does not keep a cancelled run's caller waiting either", async () => {
    const { h } = hung();
    const routine = h.manager.create(every(60));
    h.manager.runNow(routine.id); await h.manager.tick();
    const cancelled = h.manager.cancelRun(h.runs()[0]!.id, "Stopped by the person");
    await vi.advanceTimersByTimeAsync(SCHEDULER_STOP_WAIT_MS);
    await expect(cancelled).resolves.toMatchObject({ status: "cancelled" });
  });
});

describe("a routines.json that cannot be read", () => {
  const broken = '{"version":1,"routines":[{"id":"r1","name":"Fix new bugs","prompt":"Look for new bug rep';
  const corrupt = () => {
    const h = harness();
    h.manager.create(every(60));
    const good = readFileSync(h.file, "utf8");
    h.manager.close();
    writeFileSync(h.file, broken);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.at(START + 10 * MINUTE); h.manager = new RoutineManager(h.options);
    return { h, good, error };
  };

  it("is left as it is with a copy beside it, runs nothing, refuses changes, and is flagged for the app and the health report", async () => {
    const { h, error } = corrupt();
    expect(h.manager.listRoutines()).toEqual([]);
    expect(h.manager.schedulerState()).toEqual({ unreadable: true, slowStops: 0 });
    expect(() => h.manager.create(every(30))).toThrow("Saved routines could not be read");
    await h.tickAt(START + HOUR);
    h.manager.holdFor(["no_connections"]); h.manager.markAllSeen(); h.manager.stop(); h.manager.close();
    expect(readFileSync(h.file, "utf8")).toBe(broken);
    const copies = readdirSync(dirname(h.file)).filter((name) => name.startsWith("routines.json.unreadable-"));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dirname(h.file), copies[0]!), "utf8")).toBe(broken);
    expect(error).toHaveBeenCalledTimes(1);
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("cannot be read (invalid JSON)");
    expect(logged).toContain(copies[0]);
    expect(logged).not.toContain("Fix new bugs");
    expect(h.started).toEqual([]);
  });

  it("is read again until it works: its routines come back, the app is told, and the run that was due starts", async () => {
    const { h, good, error } = corrupt();
    let readable = 0;
    h.options.onReadable = () => { readable += 1; };
    await h.tickAt(START + 20 * MINUTE);
    await h.tickAt(START + 30 * MINUTE);
    expect([readable, h.manager.schedulerState().unreadable, error.mock.calls.length]).toEqual([0, true, 1]);

    writeFileSync(h.file, good);
    h.emitted.length = 0;
    await h.tickAt(START + HOUR);
    expect([readable, h.manager.schedulerState().unreadable]).toEqual([1, false]);
    expect(h.manager.listRoutines()).toMatchObject([{ name: "Fix new bugs", enabled: true }]);
    expect(h.emitted.some((frame) => frame.kind === "routine")).toBe(true);
    expect(h.started).toEqual(["thread-1"]);
    expect(h.disk().runs).toMatchObject([{ status: "running" }]);
    expect(h.manager.create(every(30, { name: "Another" }))).toMatchObject({ name: "Another" });
  });

  it("does again what start does once it can be read: a routine that runs at startup runs, and the host is told after the routines are loaded", async () => {
    const h = harness();
    h.options.launchId = "launch-1";
    h.restart();
    h.manager.create(every(24 * 60, { runOnStartup: true }));
    const good = readFileSync(h.file, "utf8");
    h.manager.close();
    writeFileSync(h.file, broken);
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.options.launchId = "launch-2";
    const seen: number[] = [];
    h.options.onReadable = () => { seen.push(h.manager.listRoutines().length); };
    h.at(START + 10 * MINUTE); h.manager = new RoutineManager(h.options);
    h.manager.start();
    expect(h.started).toEqual([]);
    writeFileSync(h.file, good);
    await h.tickAt(START + 11 * MINUTE);
    expect(seen).toEqual([1]);
    expect(h.runs()).toMatchObject([{ triggerSource: "startup", status: "running" }]);
    await h.tickAt(START + 12 * MINUTE);
    expect(h.runs()).toHaveLength(1);
    h.manager.stop();
  });

  it("loads nothing where the host starts the process afresh instead, so what settles at start sees the routines first", async () => {
    const { h, good } = corrupt();
    let asked = 0, readable = 0;
    h.options.restartsToReload = () => { asked += 1; return true; };
    h.options.onReadable = () => { readable += 1; };
    await h.tickAt(START + 20 * MINUTE);
    expect(asked).toBe(0);
    writeFileSync(h.file, good);
    await h.tickAt(START + 21 * MINUTE);
    expect([asked, readable, h.manager.schedulerState().unreadable, h.manager.listRoutines().length, h.started.length]).toEqual([1, 0, true, 0, 0]);
    expect(readFileSync(h.file, "utf8")).toBe(good);
    // The fresh process reads it at start.
    expect(h.restart().listRoutines()).toMatchObject([{ name: "Fix new bugs" }]);
  });

  it("is looked at again every minute by the running scheduler, with nothing else due", async () => {
    const h = harness();
    h.manager.create(every(60));
    const good = readFileSync(h.file, "utf8");
    h.manager.close();
    writeFileSync(h.file, broken);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ now: START + HOUR });
    h.options.now = () => Date.now();
    h.restart();
    h.manager.start();
    await vi.advanceTimersByTimeAsync(3 * UNREADABLE_RETRY_MS);
    expect(h.manager.schedulerState().unreadable).toBe(true);
    writeFileSync(h.file, good);
    await vi.advanceTimersByTimeAsync(UNREADABLE_RETRY_MS + 1_000);
    expect(h.manager.schedulerState().unreadable).toBe(false);
    expect(h.started).toEqual(["thread-1"]);
    h.manager.stop();
  });

  it("saves through a temporary file and a rename, so a reader never sees half a file", () => {
    const h = harness();
    h.manager.create(every(60));
    expect(readdirSync(dirname(h.file))).toEqual(["routines.json"]);
    expect(() => JSON.parse(readFileSync(h.file, "utf8"))).not.toThrow();
  });
});
