import { describe, expect, it } from "vitest";

import { CATCH_UP_MS, CATCH_UP_STAGGER_MS, CATCH_UP_STAGGER_STEPS, passedOccurrences, planOccurrence, staggered } from "./routine-catch-up.ts";
import { nextOccurrence, type RoutineSchedule } from "./routine-schedules.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const START = Date.parse("2026-11-16T08:00:00Z");
const cron = (expression: string): RoutineSchedule => ({ type: "cron", expression, timeZone: "UTC" });
const interval = (everyMinutes: number, more: Record<string, unknown> = {}): RoutineSchedule => ({ type: "interval", everyMinutes, anchorAt: START, ...more });

describe("the occurrences passed while nothing could start them", () => {
  it("counts an interval's slots by arithmetic and a cron's by walking them", () => {
    expect(passedOccurrences(interval(5), START + 5 * MINUTE, START + 5 * MINUTE)).toEqual({ latest: START + 5 * MINUTE, count: 1 });
    expect(passedOccurrences(interval(5), START + 5 * MINUTE, START + 22 * MINUTE)).toEqual({ latest: START + 20 * MINUTE, count: 4 });
    expect(passedOccurrences(interval(5), START + 5 * MINUTE, START + 400 * DAY)).toEqual({ latest: START + 400 * DAY, count: 400 * 288 });
    expect(passedOccurrences(cron("0 * * * *"), START + HOUR, START + 3 * HOUR + 59 * MINUTE)).toEqual({ latest: START + 3 * HOUR, count: 3 });
    expect(passedOccurrences(cron("0 9 * * 1-5"), Date.parse("2026-11-16T09:00:00Z"), Date.parse("2026-11-23T08:00:00Z"))).toEqual({ latest: Date.parse("2026-11-20T09:00:00Z"), count: 5 });
  });

  it("finds the newest slot of an every-minute rule a month later without walking the month", () => {
    const first = START + MINUTE, now = START + 30 * DAY + 30_000;
    const passed = passedOccurrences(cron("* * * * *"), first, now);
    expect(passed.latest).toBe(START + 30 * DAY);
    expect(passed.count).toBe(30 * 1_440);
  });

  it("counts only the slots an interval kept to some hours allows, and stops at its end", () => {
    const first = new Date(2026, 10, 16, 9, 0).getTime();
    const hours = interval(30, { anchorAt: first, window: { start: "09:00", end: "10:30" } });
    expect(passedOccurrences(hours, first, new Date(2026, 10, 17, 9, 40).getTime())).toEqual({ latest: new Date(2026, 10, 17, 9, 30).getTime(), count: 5 });
    const ended = interval(60, { endsAt: START + 3 * HOUR });
    expect(passedOccurrences(ended, START + HOUR, START + 9 * HOUR)).toEqual({ latest: START + 3 * HOUR, count: 3 });
  });

  it("takes a one-time run and a limit reset for the single occurrence they are", () => {
    expect(passedOccurrences({ type: "once", at: START }, START, START + DAY)).toEqual({ latest: START, count: 1 });
    expect(passedOccurrences({ type: "limit_reset", engine: "claude", repeat: "every_reset", at: START } as RoutineSchedule, START, START + DAY)).toEqual({ latest: START, count: 1 });
  });
});

describe("what a due routine does", () => {
  const plan = (schedule: RoutineSchedule, first: number, now: number, cloud = false) => planOccurrence({ schedule, nextRunAt: first }, now, cloud);

  it("runs on time with nothing else to say", () => {
    expect(plan(interval(60), START + HOUR, START + HOUR + 90_000)).toEqual({ scheduledFor: START + HOUR, first: START + HOUR, through: START + HOUR, count: 1, fields: {}, late: false });
  });

  it("runs the newest occurrence late, with the older ones closed on a row the owner need not look at", () => {
    const late = plan(interval(60), START + HOUR, START + 4 * HOUR + 10 * MINUTE);
    expect(late).toMatchObject({ scheduledFor: START + 4 * HOUR, first: START + HOUR, through: START + 4 * HOUR, count: 4, fields: {}, late: true });
    expect(late.older).toMatchObject({ scheduledFor: START + HOUR, count: 3, fields: { status: "missed", seenAt: START + 4 * HOUR + 10 * MINUTE,
      error: "Missed 3 scheduled runs because this computer was asleep or OpenMausBot was not running", skipped: { count: 3, firstAt: START + HOUR, lastAt: START + 3 * HOUR } } });
    expect(late.older!.fields.skipped).not.toHaveProperty("told");
    expect(plan(interval(60), START + HOUR, START + HOUR + 10 * MINUTE)).toEqual({ scheduledFor: START + HOUR, first: START + HOUR, through: START + HOUR, count: 1, fields: {}, late: true });
    expect(plan(cron("0 9 * * *"), Date.parse("2026-11-16T09:00:00Z"), Date.parse("2026-11-18T10:00:00Z")).older?.fields.skipped)
      .toMatchObject({ count: 2, firstAt: Date.parse("2026-11-16T09:00:00Z"), lastAt: Date.parse("2026-11-17T09:00:00Z") });
  });

  it("closes them all, and tells the owner, when the newest is too old to run", () => {
    const daily = cron("0 9 * * *"), first = Date.parse("2026-11-16T09:00:00Z");
    const one = plan(daily, first, first + CATCH_UP_MS + 1);
    expect(one).toMatchObject({ scheduledFor: first, through: first, count: 1, late: false, fields: { status: "missed", errorCode: "routines.server.missedTooLate", errorParams: { hours: 12 } } });
    expect(one.fields).not.toHaveProperty("skipped");
    expect(one.fields).not.toHaveProperty("seenAt");
    expect(plan(daily, first, first + CATCH_UP_MS).fields).toEqual({});
    const three = plan(daily, first, first + 2 * DAY + 13 * HOUR, true);
    expect(three).toMatchObject({ scheduledFor: first, through: first + 2 * DAY, count: 3,
      fields: { status: "missed", error: "Missed 3 scheduled runs because this Cloud was asleep or restarting", skipped: { count: 3, firstAt: first, lastAt: first + 2 * DAY, told: true } } });
    expect(three.older).toBeUndefined();
    expect(nextOccurrence(daily, Math.max(first + 2 * DAY + 13 * HOUR, three.through))).toBe(first + 3 * DAY);
  });

  it("runs a limit reset however late, and misses a one-time run found more than twelve hours late", () => {
    const reset = { type: "limit_reset", engine: "claude", repeat: "every_reset", at: START } as RoutineSchedule;
    expect(plan(reset, START, START + 3 * DAY)).toMatchObject({ scheduledFor: START, count: 1, fields: {} });
    expect(plan({ type: "once", at: START }, START, START + 11 * HOUR)).toMatchObject({ scheduledFor: START, fields: {}, late: true });
    expect(plan({ type: "once", at: START }, START, START + 13 * HOUR).fields).toMatchObject({ status: "missed" });
  });

  it("says the scheduler was held up, not that the computer was asleep, when a pass ended after the run came due", () => {
    const held = planOccurrence({ schedule: interval(60), nextRunAt: START + HOUR }, START + 3 * HOUR + 10 * MINUTE, true, true);
    expect(held).toMatchObject({ scheduledFor: START + 3 * HOUR, late: true });
    expect(held.older!.fields).toMatchObject({ error: "Missed 2 scheduled runs because the scheduler was held up starting another run", errorParams: { why: "routines.server.part.heldUp" } });
    expect(held.older!.fields.skipped!.behind).toMatch(/^late:/);
  });

  it("spreads late starts over steps and wraps, so the last one is never far off", () => {
    expect(staggered(START, 0)).toEqual({});
    expect(staggered(START, 3)).toEqual({ retryAt: START + 3 * CATCH_UP_STAGGER_MS });
    expect(staggered(START, CATCH_UP_STAGGER_STEPS)).toEqual({});
    expect(staggered(START, 2 * CATCH_UP_STAGGER_STEPS - 1)).toEqual({ retryAt: START + (CATCH_UP_STAGGER_STEPS - 1) * CATCH_UP_STAGGER_MS });
  });
});
