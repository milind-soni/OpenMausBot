import { describe, expect, it } from "vitest";

import { formatInstant } from "./routine-cron-text.ts";
import { MAX_DATE_MS } from "./routine-intervals.ts";
import { cleanSchedule, loadSchedule, nextOccurrence, type RoutineScheduleInput } from "./routine-schedules.ts";

describe("one-time schedules with representable dates", () => {
  it.each([MAX_DATE_MS + 1, -MAX_DATE_MS - 1, 1e100, -1e100])("rejects the finite but unrepresentable timestamp %s", (at) => {
    expect(() => cleanSchedule({ type: "once", at }, 0)).toThrow("Choose a valid date and time");
    expect(loadSchedule({ type: "once", at }, 0)).toBeNull();
  });

  it("rejects an out-of-range numeric string accepted by the input coercion", () => {
    expect(() => cleanSchedule({ type: "once", at: "1e100" } as unknown as RoutineScheduleInput, 0))
      .toThrow("Choose a valid date and time");
  });

  it.each([-MAX_DATE_MS, 0, Date.parse("2026-11-12T10:00:00Z"), MAX_DATE_MS])("keeps the valid timestamp %s displayable", (at) => {
    const schedule = cleanSchedule({ type: "once", at }, at - 1);
    expect(schedule).toEqual({ type: "once", at });
    expect(nextOccurrence(schedule, at - 1)).toBe(at);
    expect(() => formatInstant(at, "UTC")).not.toThrow();
  });

  it("keeps numeric-string compatibility for a valid timestamp", () => {
    const at = Date.parse("2026-11-12T10:00:00Z");
    expect(cleanSchedule({ type: "once", at: String(at) } as unknown as RoutineScheduleInput, 0)).toEqual({ type: "once", at });
  });
});
