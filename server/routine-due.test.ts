import { describe, expect, it } from "vitest";
import { CHECK_WAKE_MS, nextDueOf, schedulerDueOf, wakeHoldOf } from "./routine-due.ts";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 24, 9, 0);
const watch = (fields: Record<string, unknown> = {}) =>
  ({ enabled: true, nextRunAt: NOW + 10 * MINUTE, checks: ["calendar", "mail", "runs"] as const, ...fields }) as Parameters<typeof nextDueOf>[0][number];

describe("nextDueOf: a Cloud home wakes for its checks at least hourly", () => {
  it("is null with no routines, or none with checks or a next run", () => {
    expect(nextDueOf([], [], NOW)).toBeNull();
    expect(nextDueOf([{ enabled: true, nextRunAt: null }], [], NOW)).toBeNull();
    expect(nextDueOf([watch({ nextRunAt: null })], [], NOW)).toBeNull();
  });

  it("an hour after the last check", () => {
    expect(nextDueOf([watch({ checkedAt: NOW - 20 * MINUTE })], [], NOW)).toBe(NOW + 40 * MINUTE);
  });

  it("an hour from now for a routine checked just now or never", () => {
    expect(nextDueOf([watch({ checkedAt: NOW })], [], NOW)).toBe(NOW + CHECK_WAKE_MS);
    expect(nextDueOf([watch()], [], NOW)).toBe(NOW + CHECK_WAKE_MS);
  });

  it("a sooner meeting prep wins", () => {
    expect(nextDueOf([watch({ checkedAt: NOW, wakeAt: NOW + 25 * MINUTE })], [], NOW)).toBe(NOW + 25 * MINUTE);
    expect(nextDueOf([watch({ checkedAt: NOW, wakeAt: NOW + 3 * 60 * MINUTE })], [], NOW)).toBe(NOW + CHECK_WAKE_MS);
  });

  it("ignores paused routines", () => {
    expect(nextDueOf([watch({ enabled: false, checkedAt: NOW })], [], NOW)).toBeNull();
  });

  it("never before the routine's next check", () => {
    expect(nextDueOf([watch({ checkedAt: NOW, nextRunAt: NOW + 3 * 60 * MINUTE })], [], NOW)).toBe(NOW + 3 * 60 * MINUTE);
  });

  it("stays due while an overdue check waits for the scheduler", () => {
    expect(nextDueOf([watch({ checkedAt: NOW - 2 * CHECK_WAKE_MS, nextRunAt: NOW - 5 * MINUTE })], [], NOW)).toBe(NOW - 5 * MINUTE);
  });

  it("a check that ran without a checked time tries again an hour later, never holding the home awake", () => {
    expect(nextDueOf([watch({ checkedAt: NOW - 3 * CHECK_WAKE_MS, nextRunAt: NOW + 14 * MINUTE })], [], NOW)).toBe(NOW + CHECK_WAKE_MS);
  });
});

describe("wakeHoldOf: the desktop", () => {
  it("is held only for a meeting prep, never for the hourly check", () => {
    const horizon = 2 * CHECK_WAKE_MS;
    expect(wakeHoldOf([watch({ checkedAt: NOW - 2 * CHECK_WAKE_MS })], [], NOW, horizon)).toEqual({ hold: false });
    expect(wakeHoldOf([watch({ checkedAt: NOW, wakeAt: NOW + 25 * MINUTE })], [], NOW, horizon)).toEqual({ hold: true, reason: "due", at: NOW + 25 * MINUTE });
  });
});

describe("schedulerDueOf: when this process's scheduler next has work", () => {
  type Run = Parameters<typeof schedulerDueOf>[1][number];
  const run = (fields: Partial<Run>) => ({ status: "running", ...fields }) as Run;

  it("is null with nothing enabled, queued or limited", () => {
    expect(schedulerDueOf([], [], NOW, NOW)).toBeNull();
    expect(schedulerDueOf([{ enabled: false, nextRunAt: NOW }], [run({ status: "completed" }), run({ startedAt: NOW })], NOW, NOW)).toBeNull();
  });

  it("the next run, a check no sooner than checks may start, and a check's meeting wake", () => {
    expect(schedulerDueOf([{ enabled: true, nextRunAt: NOW + 5 * MINUTE }, { enabled: true, nextRunAt: NOW + 3 * MINUTE }], [], NOW, NOW)).toBe(NOW + 3 * MINUTE);
    expect(schedulerDueOf([watch({ nextRunAt: NOW - MINUTE })], [], NOW, NOW + 2 * MINUTE)).toBe(NOW + 2 * MINUTE);
    expect(schedulerDueOf([watch({ wakeAt: NOW + MINUTE })], [], NOW, NOW)).toBe(NOW + MINUTE);
    expect(schedulerDueOf([{ enabled: true, nextRunAt: null, wakeAt: NOW + MINUTE }], [], NOW, NOW)).toBeNull();
  });

  it("leaves out routines whose target is gone", () => {
    const gone = { enabled: true, nextRunAt: NOW - MINUTE, botId: "gone" };
    expect(schedulerDueOf([gone, { enabled: true, nextRunAt: NOW + MINUTE, botId: "here" }], [], NOW, NOW, (routine) => routine.botId === "gone")).toBe(NOW + MINUTE);
  });

  it("a queued run now or at its retry, and a started run when its active time reaches the limit", () => {
    expect(schedulerDueOf([], [run({ status: "queued" })], NOW, NOW)).toBe(NOW);
    expect(schedulerDueOf([], [run({ status: "queued", retryAt: NOW + MINUTE })], NOW, NOW)).toBe(NOW + MINUTE);
    expect(schedulerDueOf([], [run({ startedAt: NOW - 10 * MINUTE, timeoutMinutes: 30 })], NOW, NOW)).toBe(NOW + 20 * MINUTE);
    expect(schedulerDueOf([], [run({ status: "waiting", startedAt: NOW - 10 * MINUTE, waitedMs: 5 * MINUTE, timeoutMinutes: 30 })], NOW, NOW)).toBe(NOW + 25 * MINUTE);
    expect(schedulerDueOf([], [run({ startedAt: NOW - 40 * MINUTE, timeoutMinutes: 30 })], NOW, NOW)).toBe(NOW);
  });
});
