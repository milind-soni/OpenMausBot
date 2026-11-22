import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { latestIntervalOccurrence } from "./routine-intervals.ts";
import { cleanSchedule, nextOccurrence, type RoutineIntervalSchedule } from "./routine-schedules.ts";

beforeEach(() => { vi.stubEnv("TZ", "America/New_York"); });
afterEach(() => { vi.unstubAllEnvs(); });

function schedule(endsAt?: number): RoutineIntervalSchedule {
  return cleanSchedule({
    type: "interval", everyMinutes: 60, anchorAt: Date.parse("2026-03-01T00:00:00-05:00"),
    weekdays: [0], window: { start: "02:00", end: "03:00" }, ...(endsAt === undefined ? {} : { endsAt }),
  }, Date.parse("2026-03-01T00:00:00-05:00")) as RoutineIntervalSchedule;
}

it("finds the next allowed Sunday after the spring-forward week has no allowed hour", () => {
  expect(nextOccurrence(schedule(), Date.parse("2026-03-01T02:00:00-05:00")))
    .toBe(Date.parse("2026-03-15T02:00:00-04:00"));
});

it("finds the latest allowed occurrence across the missing-hour week", () => {
  expect(latestIntervalOccurrence(schedule(), Date.parse("2026-03-14T12:00:00-04:00")))
    .toBe(Date.parse("2026-03-01T02:00:00-05:00"));
});

it("keeps the end restriction and the ordinary weekly cadence", () => {
  expect(nextOccurrence(schedule(Date.parse("2026-03-14T23:59:00-04:00")), Date.parse("2026-03-01T02:00:00-05:00"))).toBeNull();
  expect(nextOccurrence(schedule(), Date.parse("2026-03-15T02:00:00-04:00")))
    .toBe(Date.parse("2026-03-22T02:00:00-04:00"));
  expect(latestIntervalOccurrence(schedule(), Date.parse("2026-03-22T02:00:00-04:00")))
    .toBe(Date.parse("2026-03-22T02:00:00-04:00"));
});
