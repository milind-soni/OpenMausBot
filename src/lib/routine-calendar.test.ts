import { describe, expect, it } from "vitest";

import type { Routine } from "./routines";
import {
  atLocalTime,
  formatGmtOffset,
  packCalendarCollisions,
  projectedRoutineItems,
  scheduleAt,
  slotAt,
  snapMinutes,
  startOfDay,
  startOfWeek,
} from "./routine-calendar";

describe("routine calendar geometry", () => {
  it("snaps pointer positions to 15 minute slots", () => {
    expect(snapMinutes(7)).toBe(0);
    expect(snapMinutes(8)).toBe(15);
    expect(snapMinutes(24 * 60)).toBe(23 * 60 + 45);
    const day = new Date(2026, 7, 31).getTime();
    expect(new Date(slotAt(day, 100 + 9.25 * 64, 100, 64)).getHours()).toBe(9);
    expect(new Date(slotAt(day, 100 + 9.25 * 64, 100, 64)).getMinutes()).toBe(15);
  });

  it("starts weeks on Monday", () => {
    const sunday = new Date(2026, 7, 30, 13).getTime();
    expect(new Date(startOfWeek(sunday)).getDay()).toBe(1);
    expect(new Date(startOfWeek(sunday)).getDate()).toBe(24);
  });

  it("moves a whole recurring series by weekday and wall-clock time", () => {
    const schedule = { type: "daily" as const, time: "09:00", weekdays: [1, 3] };
    const monday = new Date(2026, 7, 31, 9).getTime();
    const tuesdayAfternoon = new Date(2026, 8, 1, 14, 30).getTime();
    expect(scheduleAt(schedule, monday, tuesdayAfternoon)).toEqual({
      type: "daily",
      time: "14:30",
      weekdays: [2, 4],
    });
  });

  it("packs overlapping events into deterministic side-by-side columns", () => {
    const at = new Date(2026, 7, 31, 9).getTime();
    const layouts = packCalendarCollisions([
      { id: "later", at: at + 15 * 60_000, durationMinutes: 30 },
      { id: "first", at, durationMinutes: 60 },
      { id: "same-time", at, durationMinutes: 30 },
    ]);

    expect(layouts.get("same-time")).toEqual({ column: 0, columns: 3 });
    expect(layouts.get("first")).toEqual({ column: 1, columns: 3 });
    expect(layouts.get("later")).toEqual({ column: 2, columns: 3 });
  });

  it("reuses a column for adjacent 15 minute events", () => {
    const at = new Date(2026, 7, 31, 9).getTime();
    const layouts = packCalendarCollisions([
      { id: "one", at, durationMinutes: 15 },
      { id: "two", at: at + 15 * 60_000, durationMinutes: 15 },
    ]);

    expect(layouts.get("one")).toEqual({ column: 0, columns: 1 });
    expect(layouts.get("two")).toEqual({ column: 0, columns: 1 });
  });

  it("formats whole-hour and fractional GMT offsets", () => {
    expect(formatGmtOffset(0)).toBe("GMT+0");
    expect(formatGmtOffset(330)).toBe("GMT+5:30");
    expect(formatGmtOffset(-480)).toBe("GMT-8");
  });
});

describe("routine calendar projection", () => {
  it("projects future recurring entries but does not duplicate run receipts", () => {
    const monday = startOfDay(new Date(2026, 7, 31, 12).getTime());
    const routine: Routine = {
      id: "r1",
      name: "Brief",
      prompt: "Summarize",
      botId: "b1",
      runOn: "maus",
      enabled: true,
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2] },
      durationMinutes: 30,
      nextRunAt: atLocalTime(monday, "09:00"),
      createdAt: monday - 100,
      updatedAt: monday - 100,
    };
    const receiptAt = atLocalTime(monday, "09:00");
    const items = projectedRoutineItems(
      [routine],
      [{
        id: "run1",
        routineId: routine.id,
        routineName: routine.name,
        botId: routine.botId,
        runOn: "maus",
        scheduledFor: receiptAt,
        status: "completed",
        manual: false,
        createdAt: receiptAt,
      }],
      monday,
      monday + 3 * 86_400_000,
    );
    expect(items).toHaveLength(2);
    expect(items.map((item) => new Date(item.at).getDay())).toEqual([1, 2]);
    expect(items[0]?.run?.id).toBe("run1");
  });
});
