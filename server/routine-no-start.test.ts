import { describe, expect, it } from "vitest";

import { RUN_COMPUTER_LINES } from "../shared/cloud-computer-recovery.ts";
import { NO_START_FIRST_SPACING_MS, NO_START_SPACING_MS, SWITCHED_OFF_WITHIN_MS, afterSpacing, failedToStartComputer, noStartAlert, noStartSpacing, switchedOffByNoStarts, turnBackOn } from "./routine-no-start.ts";

const NO_START = "Maus's cloud desktop didn't start. Change where this routine runs.";
const failed = (id: string, at: number, error = NO_START, routineId = "r") => ({ id, routineId, status: "failed", error, createdAt: at, finishedAt: at + 50 });
const completed = (id: string, at: number, routineId = "r") => ({ id, routineId, status: "completed", createdAt: at, finishedAt: at + 50 });

describe("a routine whose cloud computer does not start", () => {
  it("knows that failure from one that passes by itself", () => {
    expect(failedToStartComputer(failed("a", 1))).toBe(true);
    expect(failedToStartComputer(failed("a", 1, "Cloud computers are busy right now. Try again in a few minutes."))).toBe(false);
    expect(failedToStartComputer(completed("a", 1))).toBe(false);
  });

  it("does not take a run that never started, because its computer was not ready, for that failure: the next scheduled run tries again", () => {
    for (const line of Object.values(RUN_COMPUTER_LINES)) expect(failedToStartComputer(failed("a", 1, line)), line).toBe(false);
    const notReady = [1, 2, 3, 4].map((at) => failed(`run-${at}`, at * 100, RUN_COMPUTER_LINES.noAnswer));
    expect(noStartSpacing({ id: "r", updatedAt: 0 }, notReady)).toBeNull();
    expect(noStartAlert({ id: "r", updatedAt: 0 }, notReady.slice(0, 3), notReady[2]!)).toBeUndefined();
  });

  it("spaces its scheduled runs an hour after the third failure in a row and four hours after each later one", () => {
    const routine = { id: "r", updatedAt: 0 };
    expect(noStartSpacing(routine, [failed("a", 100), failed("b", 200)])).toBeNull();
    expect(noStartSpacing(routine, [failed("a", 100), failed("b", 200), failed("c", 300)])).toMatchObject({ streak: 3, until: 350 + NO_START_FIRST_SPACING_MS, last: { id: "c" } });
    expect(noStartSpacing(routine, [failed("a", 100), failed("b", 200), failed("c", 300), failed("d", 400)])).toMatchObject({ streak: 4, until: 450 + NO_START_SPACING_MS });
  });

  it("ends the spacing with the first run that works, another kind of failure, or a change to the routine", () => {
    const three = [failed("a", 100), failed("b", 200), failed("c", 300)];
    expect(noStartSpacing({ id: "r", updatedAt: 0 }, [...three, completed("d", 400)])).toBeNull();
    expect(noStartSpacing({ id: "r", updatedAt: 0 }, [...three, failed("d", 400, "The bot did not complete this run")])).toBeNull();
    expect(noStartSpacing({ id: "r", updatedAt: 250 }, three)).toBeNull();
    expect(noStartSpacing({ id: "other", updatedAt: 0 }, three)).toBeNull();
  });

  it("tells the owner once, at the failure that begins the spacing", () => {
    const routine = { id: "r", updatedAt: 0 };
    const [a, b, c, d] = [failed("a", 100), failed("b", 200), failed("c", 300), failed("d", 400)];
    expect(noStartAlert(routine, [a, b], b)).toBeUndefined();
    expect(noStartAlert(routine, [a, b, c], c)).toEqual({ detail: `${NO_START} 3 runs in a row failed this way. It stays on, and tries again less often until its cloud desktop starts.` });
    expect(noStartAlert(routine, [a, b, c, d], d)).toBeUndefined();
    expect(noStartAlert(undefined, [a, b, c], c)).toBeUndefined();
  });
});

describe("a spaced routine's next run, for planning when the computer must be awake", () => {
  const HOUR = 60 * 60_000;
  const three = [failed("a", 100), failed("b", 200), failed("c", 300)];
  const every = (minutes: number) => (_schedule: unknown, after: number) => (Math.floor(after / (minutes * 60_000)) + 1) * minutes * 60_000;
  const routine = (nextRunAt: number | null, more: Record<string, unknown> = {}) => ({ id: "r", updatedAt: 0, enabled: true, nextRunAt, schedule: {}, ...more });

  it("is the first occurrence at or after the spacing's end, not one it will skip", () => {
    const until = 350 + NO_START_FIRST_SPACING_MS;
    expect(afterSpacing(routine(5 * 60_000), three, 1_000, every(5)).nextRunAt).toBe(65 * 60_000);
    expect(afterSpacing(routine(5 * 60_000), three, 1_000, every(5)).nextRunAt).toBeGreaterThanOrEqual(until);
    expect(afterSpacing(routine(5 * 60_000), three, 1_000, (_schedule, after) => after + 1).nextRunAt).toBe(until);
  });

  it("is the routine's own next run when it is not spaced, the spacing is over, or the run is after it anyway", () => {
    const plain = routine(5 * 60_000);
    expect(afterSpacing(plain, three.slice(0, 2), 1_000, every(5))).toBe(plain);
    expect(afterSpacing(plain, three, 350 + NO_START_FIRST_SPACING_MS, every(5))).toBe(plain);
    const daily = routine(24 * HOUR);
    expect(afterSpacing(daily, three, 1_000, every(5))).toBe(daily);
    const off = routine(null, { enabled: false });
    expect(afterSpacing(off, three, 1_000, every(5))).toBe(off);
  });
});

describe("routines an earlier version turned off after three such failures", () => {
  const three = [failed("a", 100), failed("b", 200), failed("c", 300)];
  const off = (more: Record<string, unknown> = {}) => ({ id: "r", enabled: false, nextRunAt: null, updatedAt: 350, schedule: { type: "interval" }, ...more });

  it("are recognised by their last change being the instant the third failure ended", () => {
    expect(switchedOffByNoStarts([off()], three, 10_000)).toHaveLength(1);
    expect(switchedOffByNoStarts([off({ updatedAt: 351 })], three, 10_000)).toHaveLength(1);
  });

  it("are left as they are when the switch-off is more than thirty days old", () => {
    expect(switchedOffByNoStarts([off()], three, 350 + SWITCHED_OFF_WITHIN_MS)).toHaveLength(1);
    expect(switchedOffByNoStarts([off()], three, 350 + SWITCHED_OFF_WITHIN_MS + 1)).toEqual([]);
  });

  it.each([
    ["one a person turned off later", off({ updatedAt: 350 + 60_000 }), three],
    ["one changed before the failure ended", off({ updatedAt: 349 }), three],
    ["one held because its owner left", off({ heldFor: "no_connections" }), three],
    ["one that is on", off({ enabled: true }), three],
    ["a one-time routine", off({ schedule: { type: "once" } }), three],
    ["one with two such failures", off({ updatedAt: 250 }), three.slice(0, 2)],
    ["one whose failures differ in wording", off(), [failed("a", 100), failed("b", 200, "Ada's cloud desktop didn't start."), failed("c", 300)]],
    ["one whose newest outcome is another failure", off({ updatedAt: 450 }), [...three, failed("d", 400, "The bot did not complete this run")]],
    ["one that ran again since", off(), [...three, { id: "d", routineId: "r", status: "running", createdAt: 400 }]],
    ["one whose failed runs are gone", off(), []],
  ])("leave alone %s", (_what, routine, runs) => {
    expect(switchedOffByNoStarts([routine], runs, 10_000)).toEqual([]);
  });

  it("come back on from now, counted as changed so the next run is not held back", () => {
    const routine = off();
    expect(turnBackOn([routine], three, undefined, 10_000, () => 12_000)).toEqual([routine]);
    expect(routine).toMatchObject({ enabled: true, nextRunAt: 12_000, updatedAt: 10_000 });
    expect(noStartSpacing(routine, three)).toBeNull();
    expect(turnBackOn([routine], three, undefined, 20_000, () => 22_000)).toEqual([]);
  });

  it("stay off under the cause that holds every routine, stamped so they come back when it ends", () => {
    const routine = off();
    turnBackOn([routine], three, "no_connections", 10_000, () => 12_000);
    expect(routine).toMatchObject({ enabled: false, nextRunAt: null, heldFor: "no_connections" });
    expect(switchedOffByNoStarts([routine], three, 20_000)).toEqual([]);
  });
});
