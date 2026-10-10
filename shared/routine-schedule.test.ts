import { Cron, scheduledJobs } from "croner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCronSchedule, nextCronRuns, type RoutineCronSchedule } from "./routine-schedule.ts";

const schedule = (expression: string, timeZone = "UTC"): RoutineCronSchedule => ({ type: "cron", expression, timeZone });
const runs = (expression: string, after: string, count = 3, timeZone = "UTC") =>
  nextCronRuns(schedule(expression, timeZone), Date.parse(after), count).map(at => new Date(at).toISOString());

afterEach(() => vi.restoreAllMocks());

describe("cron date calculator", () => {
  it("normalizes five fields and preserves the explicitly chosen timezone", () => {
    expect(normalizeCronSchedule(schedule("  0  9\t1 * *  ", " Asia/Kolkata "))).toEqual(schedule("0 9 1 * *", "Asia/Kolkata"));
    expect(runs("0 9 1 * *", "2026-09-13T12:00:00Z", 3, "Asia/Kolkata")).toEqual([
      "2026-10-01T03:30:00.000Z", "2026-11-01T03:30:00.000Z", "2026-12-01T03:30:00.000Z",
    ]);
  });

  it("calculates hourly, daily, weekday and annual work strictly after the cursor", () => {
    expect(runs("0 * * * *", "2026-09-13T12:00:00Z", 2)).toEqual(["2026-09-13T13:00:00.000Z", "2026-09-13T14:00:00.000Z"]);
    expect(runs("15 9 * * *", "2026-09-13T09:14:59.999Z", 2)).toEqual(["2026-09-13T09:15:00.000Z", "2026-09-14T09:15:00.000Z"]);
    expect(runs("0 9 * * MON-FRI", "2026-09-11T09:00:00Z", 2)).toEqual(["2026-09-14T09:00:00.000Z", "2026-09-15T09:00:00.000Z"]);
    expect(runs("0 0 1 1 *", "2026-12-31T23:59:00Z", 2)).toEqual(["2027-01-01T00:00:00.000Z", "2028-01-01T00:00:00.000Z"]);
  });

  it("skips missing month dates and finds leap days without rolling into another month", () => {
    expect(runs("0 9 31 * *", "2026-01-31T09:00:00Z", 3)).toEqual([
      "2026-03-31T09:00:00.000Z", "2026-05-31T09:00:00.000Z", "2026-07-31T09:00:00.000Z",
    ]);
    expect(runs("0 9 29 2 *", "2025-01-01T00:00:00Z", 2)).toEqual(["2028-02-29T09:00:00.000Z", "2032-02-29T09:00:00.000Z"]);
  });

  it("supports last day, last weekday and nth weekday calendar patterns", () => {
    expect(runs("0 9 L * *", "2026-02-01T00:00:00Z", 2)).toEqual(["2026-02-28T09:00:00.000Z", "2026-03-31T09:00:00.000Z"]);
    expect(runs("0 9 LW * *", "2026-05-01T00:00:00Z", 1)).toEqual(["2026-05-29T09:00:00.000Z"]);
    expect(runs("0 9 * * MON#2", "2026-09-01T00:00:00Z", 2)).toEqual(["2026-09-14T09:00:00.000Z", "2026-10-12T09:00:00.000Z"]);
  });

  it("uses normal cron OR semantics when both day-of-month and weekday are specified", () => {
    expect(runs("0 9 1 * MON", "2026-09-30T23:59:00Z", 2)).toEqual(["2026-10-01T09:00:00.000Z", "2026-10-05T09:00:00.000Z"]);
  });

  it("advances a nonexistent DST clock time through the spring gap", () => {
    expect(runs("30 2 * * *", "2026-03-07T00:00:00Z", 3, "America/New_York")).toEqual([
      "2026-03-07T07:30:00.000Z", "2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z",
    ]);
  });

  it("runs a repeated DST clock time once, at its first occurrence", () => {
    expect(runs("30 1 * * *", "2026-10-31T00:00:00Z", 3, "America/New_York")).toEqual([
      "2026-10-31T05:30:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z",
    ]);
    expect(runs("30 1 * * *", "2026-11-01T05:45:00Z", 1, "America/New_York")).toEqual(["2026-11-02T06:30:00.000Z"]);
    expect(runs("30 1 * * *", "2026-11-01T06:05:00Z", 1, "America/New_York")).toEqual(["2026-11-02T06:30:00.000Z"]);
    expect(runs("* * * * *", "2026-11-01T06:05:00Z", 2, "America/New_York")).toEqual([
      "2026-11-01T07:00:00.000Z", "2026-11-01T07:01:00.000Z",
    ]);
  });

  it("only expands past a repeated clock time as far as the preview needs", () => {
    const calculate = vi.spyOn(Cron.prototype, "nextRuns");
    expect(runs("30 1 * * *", "2026-11-01T06:05:00Z", 1, "America/New_York")).toEqual(["2026-11-02T06:30:00.000Z"]);
    expect(calculate.mock.calls.map(call => call[0])).toEqual([1, 2]);
  });

  it.each(["@monthly", "0 0 9 1 * *", "0 0 9 1 * * 2027", "0 9 * *", "0 9 * * * @daily", "*".repeat(300)])("rejects non-five-field expression %s", expression => {
    expect(() => normalizeCronSchedule(schedule(expression))).toThrow(/five fields/);
  });

  it.each(["60 9 * * *", "0 24 * * *", "0 9 32 * *", "0 9 * 13 *", "0 9 * * 8", "*/0 * * * *"])("rejects malformed expression %s", expression => {
    expect(() => normalizeCronSchedule(schedule(expression))).toThrow(/Invalid cron expression/);
  });

  it.each(["", "+05:30", "Mars/Olympus", "Asia/Kolkata/Unknown"])("rejects invalid or ambiguous zone %s", timeZone => {
    expect(() => normalizeCronSchedule(schedule("0 9 1 * *", timeZone))).toThrow(/IANA timezone/);
  });

  it("rejects impossible or exhausted schedules instead of recording a permanently idle routine", () => {
    expect(() => normalizeCronSchedule(schedule("0 9 31 2 *"))).toThrow(/no future runs/);
    expect(() => normalizeCronSchedule(schedule("0 9 31 4 *"))).toThrow(/no future runs/);
    expect(() => normalizeCronSchedule(schedule("0 0 1 1 *"), Date.parse("3000-01-01T00:00:00Z"))).toThrow(/no future runs/);
  });

  it.each(["endsAt", "startAt", "weekdays", "window"])("does not silently discard an unsupported cron restriction: %s", key => {
    expect(() => normalizeCronSchedule({ ...schedule("0 9 1 * *"), [key]: 123 })).toThrow(/not supported/);
  });

  it("bounds preview input and creates no timers or hidden scheduled jobs", () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    const before = [...scheduledJobs];
    const value = normalizeCronSchedule(schedule("0 9 1 * *"));
    expect(nextCronRuns(value, Date.now(), 3)).toHaveLength(3);
    expect(timeout).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled();
    expect(scheduledJobs).toEqual(before);
    for (const count of [0, -1, 1001, 1.5, Infinity]) expect(() => nextCronRuns(value, Date.now(), count)).toThrow(/1 and 1000/);
    expect(() => nextCronRuns(value, NaN, 3)).toThrow(/preview date/);
  });
});
