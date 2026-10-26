import { describe, expect, it } from "vitest";
import { CHECK_WAKE_MS, nextDueOf, wakeHoldOf } from "./routine-due.ts";

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
