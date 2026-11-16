import { afterEach, describe, expect, it, vi } from "vitest";

import { ROUTINE_GOAL_RUN_LIMIT_MINUTES, ROUTINE_RUN_LIMIT_MINUTES } from "../shared/routines.ts";
import {
  COUNT_STEP_CAP_MS, COUNT_STEP_MS, RunClock, SCHEDULER_STOP_WAIT_MS, STOP_CONFIRM_WAIT_MS, STOP_RETRY_MS, SlowStops, busyWait, markStop, runLimitAt, runOverLimit,
  withBoundedStops, type StopState,
} from "./routine-bounds.ts";
import { ROUTINE_BUSY_WAIT_MS } from "./routine-recovery.ts";
import type { RoutineManagerOptions, RoutineRun } from "./routines.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const run = (more: Partial<RoutineRun> = {}): RoutineRun => ({
  id: "run", routineId: "r", routineName: "Check", target: "bot", botId: "bot-1", runOn: "maus", scheduledFor: 0, status: "running", manual: false, createdAt: 0, startedAt: 0, ...more,
});
/** Scheduler passes a minute apart from `from` to `to`, as while a run works. */
const passes = (row: RoutineRun, clock: RunClock, from: number, to: number) => {
  let over = null;
  for (let at = from; at <= to && !over; at += MINUTE) over = runOverLimit(row, clock, at);
  return over;
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the work a run has done", () => {
  it("is added up pass by pass while it is running, from its start", () => {
    const row = run(), clock = new RunClock();
    clock.from(row, "workedMs", 0);
    expect(passes(row, clock, MINUTE, 90 * MINUTE)).toBeNull();
    expect(row.workedMs).toBe(90 * MINUTE);
  });

  it("leaves out the hours a computer slept, and a clock that jumped: one pass adds two steps at most", () => {
    const row = run(), clock = new RunClock();
    clock.from(row, "workedMs", 0);
    passes(row, clock, MINUTE, 10 * MINUTE);
    expect(runOverLimit(row, clock, 10 * MINUTE + 9 * HOUR)).toBeNull();
    expect(row.workedMs).toBe(10 * MINUTE + COUNT_STEP_CAP_MS);
    expect(runOverLimit(row, clock, 10 * MINUTE + 9 * HOUR - 30 * MINUTE)).toBeNull();
    expect(row.workedMs).toBe(10 * MINUTE + COUNT_STEP_CAP_MS);
    expect(COUNT_STEP_CAP_MS).toBe(2 * COUNT_STEP_MS);
  });

  it("leaves out every wait, and counts on from when the run goes back to work", () => {
    const row = run(), clock = new RunClock();
    clock.from(row, "workedMs", 0);
    passes(row, clock, MINUTE, 30 * MINUTE);
    clock.rest(row, 30 * MINUTE + 20_000);
    Object.assign(row, { status: "waiting", waitingSince: 30 * MINUTE + 20_000 });
    expect(row.workedMs).toBe(30 * MINUTE + 20_000);
    expect(passes(row, clock, 31 * MINUTE, 40 * HOUR)).toBeNull();
    expect(row.workedMs).toBe(30 * MINUTE + 20_000);
    clock.work(row, 40 * HOUR);
    expect(row).toMatchObject({ status: "running" });
    passes(row, clock, 40 * HOUR + MINUTE, 40 * HOUR + 10 * MINUTE);
    expect(row.workedMs).toBe(40 * MINUTE + 20_000);
  });

  it("adds nothing for the time before a process first saw the run", () => {
    const row = run({ workedMs: 20 * MINUTE }), clock = new RunClock();
    expect(runOverLimit(row, clock, 50 * HOUR)).toBeNull();
    expect(runOverLimit(row, clock, 50 * HOUR + MINUTE)).toBeNull();
    expect(row.workedMs).toBe(21 * MINUTE);
  });
});

describe("the run limit", () => {
  it("stops a bot's run with no limit of its own once it has worked three hours, and names that limit", () => {
    expect(ROUTINE_RUN_LIMIT_MINUTES).toBe(180);
    const row = run(), clock = new RunClock();
    clock.from(row, "workedMs", 0);
    expect(passes(row, clock, MINUTE, 3 * HOUR - MINUTE)).toBeNull();
    expect(runOverLimit(row, clock, 3 * HOUR)).toEqual({ text: "Stopped: this run ran longer than the 3-hour limit", codes: { errorCode: "routines.server.overLimit", errorParams: { hours: 3 } } });
  });

  it("gives a room goal's run, which stays running across its members' turns, twelve hours", () => {
    expect(ROUTINE_GOAL_RUN_LIMIT_MINUTES).toBe(720);
    const row = run({ target: "room-goal" }), clock = new RunClock();
    clock.from(row, "workedMs", 0);
    expect(passes(row, clock, MINUTE, 12 * HOUR - MINUTE)).toBeNull();
    expect(row.workedMs).toBe(12 * HOUR - MINUTE);
    expect(runOverLimit(row, clock, 12 * HOUR)).toEqual({ text: "Stopped: this run ran longer than the 12-hour limit", codes: { errorCode: "routines.server.overLimit", errorParams: { hours: 12 } } });
  });

  it("does not stop a room goal that says it needs input, however long it waits", () => {
    const row = run({ target: "room-goal", status: "waiting", goalStatus: "needs-input", waitingSince: HOUR, workedMs: HOUR }), clock = new RunClock();
    expect(passes(row, clock, HOUR, 40 * HOUR)).toBeNull();
    expect(runLimitAt(row, 40 * HOUR)).toBeNull();
  });

  it("asks the scheduler back a minute on while a run works under the default limit, sooner when less is left", () => {
    expect(runLimitAt(run({ workedMs: HOUR }), 5 * HOUR)).toBe(5 * HOUR + COUNT_STEP_MS);
    expect(runLimitAt(run({ workedMs: 3 * HOUR - 20_000 }), 5 * HOUR)).toBe(5 * HOUR + 20_000);
    expect(runLimitAt(run({ workedMs: 4 * HOUR }), 5 * HOUR)).toBe(5 * HOUR);
    expect(runLimitAt(run({ status: "waiting", waitingSince: HOUR }), 5 * HOUR)).toBeNull();
  });

  it("leaves a queued or finished run alone", () => {
    const clock = new RunClock();
    for (const status of ["queued", "completed", "failed", "missed", "cancelled"] as const) {
      expect(runOverLimit(run({ status, workedMs: 9 * HOUR }), clock, 30 * HOUR)).toBeNull();
      expect(runLimitAt(run({ status }), 30 * HOUR)).toBeNull();
    }
    expect(runOverLimit(run({ startedAt: undefined }), clock, 30 * HOUR)).toBeNull();
  });

  it("keeps a routine's own limit, in its own words, counted as it always was", () => {
    const clock = new RunClock();
    const own = run({ timeoutMinutes: 10 });
    expect(runOverLimit(own, clock, 10 * MINUTE - 1)).toBeNull();
    expect(runOverLimit(own, clock, 10 * MINUTE)).toEqual({ text: "Stopped after reaching the 10-minute run limit", codes: { errorCode: undefined, errorParams: undefined } });
    const long = run({ timeoutMinutes: 1_440 });
    expect(runOverLimit(long, clock, 24 * HOUR - 1)).toBeNull();
    expect(runOverLimit(long, clock, 24 * HOUR)?.text).toBe("Stopped after reaching the 1440-minute run limit");
    const handedOn = run({ timeoutMinutes: 10, status: "waiting", waitingSince: MINUTE });
    expect(runOverLimit(handedOn, clock, 10 * MINUTE)?.text).toBe("Stopped after reaching the 10-minute run limit");
    expect(runLimitAt(handedOn, 5 * MINUTE)).toBe(10 * MINUTE);
    const asked = run({ timeoutMinutes: 10, status: "waiting", waitingSince: MINUTE, asked: { approval: false, subject: "Which?", since: MINUTE } });
    expect(runOverLimit(asked, clock, 5 * HOUR)).toBeNull();
    expect(runLimitAt(asked, 5 * HOUR)).toBeNull();
  });
});

describe("a queued run behind its busy bot", () => {
  const queued = (more: Partial<RoutineRun> = {}) => run({ status: "queued", startedAt: undefined, ...more });
  const seen = (row: RoutineRun, clock: RunClock, from: number, to: number, counts = true) => {
    let last = busyWait(row, clock, counts, from);
    for (let at = from + 10_000; at <= to && !last.missed; at += 10_000) last = busyWait(row, clock, counts, at);
    return last;
  };

  it("is given up once the passes that saw it busy add up to an hour, with the reason", () => {
    const row = queued(), clock = new RunClock();
    expect(busyWait(row, clock, true, 1_000)).toEqual({ changed: true, missed: null });
    expect(row.busyMs).toBe(0);
    expect(seen(row, clock, 1_000, 1_000 + ROUTINE_BUSY_WAIT_MS - 10_000).missed).toBeNull();
    expect(busyWait(row, clock, true, 1_000 + ROUTINE_BUSY_WAIT_MS).missed).toEqual({ text: "Did not run: the bot was busy for more than 60 minutes",
      codes: { errorCode: "routines.server.busyTooLong", errorParams: { minutes: 60 } } });
  });

  it("is worth saving once a minute, not at every pass", () => {
    const row = queued(), clock = new RunClock();
    const changes = [0, 10, 20, 30, 40, 50, 60, 70].map((seconds) => busyWait(row, clock, true, seconds * 1_000).changed);
    expect(changes).toEqual([true, false, false, false, false, false, true, false]);
  });

  it("does not count the hours a computer slept, or the time a process was down", () => {
    const row = queued(), clock = new RunClock();
    seen(row, clock, 0, 10 * MINUTE);
    expect(busyWait(row, clock, true, 10 * MINUTE + 8 * HOUR).missed).toBeNull();
    expect(row.busyMs).toBe(10 * MINUTE + COUNT_STEP_CAP_MS);
    const afterRestart = new RunClock();
    expect(busyWait(row, afterRestart, true, 90 * HOUR).missed).toBeNull();
    expect(row.busyMs).toBe(10 * MINUTE + COUNT_STEP_CAP_MS);
  });

  it("drops the count as soon as it is not that wait: a run of checked items, an event's or a person's run, or one behind its own routine", () => {
    const row = queued(), clock = new RunClock();
    seen(row, clock, 0, 30 * MINUTE);
    expect(busyWait(row, clock, false, 31 * MINUTE)).toEqual({ changed: true, missed: null });
    expect(row).not.toHaveProperty("busyMs");
    expect(seen(row, clock, 31 * MINUTE, 30 * HOUR, false)).toEqual({ changed: false, missed: null });
    expect(seen(row, clock, 30 * HOUR, 30 * HOUR + 59 * MINUTE).missed).toBeNull();
    expect(row.busyMs).toBe(59 * MINUTE);
  });
});

describe("stopping a turn from the scheduler", () => {
  const base = { botState: () => "ready" as const, createTask: () => null, startTurn: async () => {} } satisfies RoutineManagerOptions;
  const watch = (now: () => number = Date.now) => {
    const states: Array<[string, StopState]> = [];
    return { states, slow: new SlowStops(now, (threadId, state) => states.push([threadId, state])) };
  };

  it("goes on after ten seconds when the engine never answers, counts it, and holds the conversation as not confirmed", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { slow, states } = watch();
    const options = withBoundedStops({ ...base, interruptTurn: () => new Promise<void>(() => {}), interruptGoal: () => new Promise<void>(() => {}) }, slow);
    let done = 0;
    void options.interruptTurn!("bot-1", "thread-1").then(() => { done += 1; });
    void options.interruptGoal!("room-1", "thread-2", { status: "stopped", detail: "x" }).then(() => { done += 1; });
    await vi.advanceTimersByTimeAsync(SCHEDULER_STOP_WAIT_MS - 1);
    expect([done, slow.count]).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(1);
    expect([done, slow.count]).toEqual([2, 2]);
    expect(states).toEqual([["thread-1", "pending"], ["thread-2", "pending"]]);
    expect([slow.holds("thread-1"), slow.holds("thread-2"), slow.holds("thread-3"), slow.holds(undefined)]).toEqual([true, true, false, false]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("confirms the stop when it returns late, or when the turn's end arrives, and lets go then", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { slow, states } = watch();
    let finish = () => {};
    const options = withBoundedStops({ ...base, interruptTurn: (_botId, threadId) => threadId === "late" ? new Promise<void>((resolve) => { finish = resolve; }) : new Promise<void>(() => {}) }, slow);
    void options.interruptTurn!("bot-1", "late");
    void options.interruptTurn!("bot-1", "event");
    await vi.advanceTimersByTimeAsync(SCHEDULER_STOP_WAIT_MS);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    slow.confirmed("event");
    slow.confirmed("never-stopped");
    expect(states).toEqual([["late", "pending"], ["event", "pending"], ["late", "confirmed"], ["event", "confirmed"]]);
    expect([slow.holds("late"), slow.holds("event")]).toEqual([false, false]);
  });

  it("sends the stop again each minute, and gives up after five", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = 0;
    const { slow, states } = watch(() => now);
    slow.timedOut("thread-1");
    now = STOP_RETRY_MS - 1; expect(slow.sweep()).toEqual([]);
    now = STOP_RETRY_MS; expect(slow.sweep()).toEqual(["thread-1"]);
    now = STOP_RETRY_MS + 1_000; expect(slow.sweep()).toEqual([]);
    slow.timedOut("thread-1");
    now = 2 * STOP_RETRY_MS; expect(slow.sweep()).toEqual(["thread-1"]);
    now = STOP_CONFIRM_WAIT_MS - 1; slow.sweep(); expect(slow.holds("thread-1")).toBe(true);
    now = STOP_CONFIRM_WAIT_MS; expect(slow.sweep()).toEqual([]);
    expect(slow.holds("thread-1")).toBe(false);
    expect(states).toEqual([["thread-1", "pending"], ["thread-1", "unconfirmed"]]);
    expect(slow.count).toBe(2);
  });

  it("returns as soon as the stop does, passes a failure on, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const { slow, states } = watch();
    const stops: string[] = [];
    const source: RoutineManagerOptions = { ...base, interruptTurn: async (_botId, threadId) => { stops.push(threadId); if (threadId === "bad") throw new Error("gone"); } };
    const options = withBoundedStops(source, slow);
    await options.interruptTurn!("bot-1", "thread-1");
    await expect(options.interruptTurn!("bot-1", "bad")).rejects.toThrow("gone");
    expect([stops, slow.count, states, vi.getTimerCount()]).toEqual([["thread-1", "bad"], 0, [], 0]);
  });

  it("stays a live view of the options: one set later is used, and one never set stays unset", async () => {
    const source: RoutineManagerOptions = { ...base };
    const options = withBoundedStops(source, watch().slow);
    expect(options.interruptTurn).toBeUndefined();
    expect(options.botState("bot-1")).toBe("ready");
    const stops: string[] = [];
    source.interruptTurn = async (_botId, threadId) => { stops.push(threadId); };
    source.pausedText = () => "paused";
    await options.interruptTurn!("bot-1", "thread-9");
    expect([stops, options.pausedText?.("bot-1")]).toEqual([["thread-9"], "paused"]);
  });

  it("marks the finished run's row while its stop is outstanding, clears the mark once confirmed, and says so for good when it never is", () => {
    const row = run({ status: "failed", error: "Stopped after reaching the 30-minute run limit" });
    expect(markStop(row, "pending")).toBe(true);
    expect(row).toMatchObject({ attention: "Its turn has not confirmed that it stopped. The next run waits for that, up to 5 minutes.", attentionCode: "routines.server.stopPending", attentionParams: { minutes: 5 } });
    expect(markStop(row, "confirmed")).toBe(true);
    expect(row.attention).toBeUndefined();
    expect(markStop(row, "confirmed")).toBe(false);
    markStop(row, "pending");
    expect(markStop(row, "unconfirmed")).toBe(true);
    expect(row).toMatchObject({ attention: "Its turn never confirmed that it stopped, so the next run started without that.", attentionCode: "routines.server.stopUnconfirmed", error: "Stopped after reaching the 30-minute run limit" });
    expect(markStop(run({ status: "running" }), "pending")).toBe(false);
  });
});
