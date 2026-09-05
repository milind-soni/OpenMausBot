import { describe, expect, it } from "vitest";

import type { Routine, RoutineRun } from "./routines";
import {
  atLocalTime,
  formatGmtOffset,
  intervalAnchorForSave,
  nextIntervalAnchor,
  packCalendarCollisions,
  projectedRoutineItems,
  scheduleAt,
  slotAt,
  snapMinutes,
  startOfDay,
  startOfWeek,
} from "./routine-calendar";

describe("routine calendar geometry", () => {
  it("anchors a new interval one cadence after save on a clean minute", () => {
    const saveClick = new Date(2026, 7, 31, 9, 12, 34, 567).getTime();
    const anchor = nextIntervalAnchor(saveClick, 5);

    expect(anchor).toBe(new Date(2026, 7, 31, 9, 18).getTime());
    expect(anchor - saveClick).toBeGreaterThanOrEqual(5 * 60_000);
    expect(new Date(anchor).getSeconds()).toBe(0);
    expect(new Date(anchor).getMilliseconds()).toBe(0);
  });

  it("preserves an interval anchor only while its cadence is unchanged", () => {
    const saveClick = new Date(2026, 7, 31, 9, 12, 34, 567).getTime();
    const current = { everyMinutes: 5, anchorAt: new Date(2026, 7, 1, 9).getTime() };

    expect(intervalAnchorForSave(saveClick, 5, current)).toBe(current.anchorAt);
    expect(intervalAnchorForSave(saveClick, 10, current)).toBe(new Date(2026, 7, 31, 9, 23).getTime());
  });

  it("snaps pointer positions to 5 minute slots", () => {
    expect(snapMinutes(2)).toBe(0);
    expect(snapMinutes(3)).toBe(5);
    expect(snapMinutes(24 * 60)).toBe(23 * 60 + 55);
    const day = new Date(2026, 7, 31).getTime();
    expect(new Date(slotAt(day, 100 + 9.1 * 64, 100, 64)).getHours()).toBe(9);
    expect(new Date(slotAt(day, 100 + 9.1 * 64, 100, 64)).getMinutes()).toBe(5);
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

  it("shifts an interval series without changing its cadence", () => {
    const anchor = new Date(2026, 7, 31, 9).getTime();
    const occurrence = anchor + 15 * 60_000;
    const moved = new Date(2026, 7, 31, 10, 5).getTime();
    expect(scheduleAt({ type: "interval", everyMinutes: 15, anchorAt: anchor }, occurrence, moved)).toEqual({
      type: "interval",
      everyMinutes: 15,
      anchorAt: new Date(2026, 7, 31, 9, 50).getTime(),
    });
  });

  it("keeps interval day, time-window, and end restrictions when moving a series", () => {
    const anchor = new Date(2026, 7, 31, 9).getTime();
    const occurrence = anchor + 30 * 60_000;
    const moved = new Date(2026, 7, 31, 11).getTime();
    expect(scheduleAt({
      type: "interval",
      everyMinutes: 30,
      anchorAt: anchor,
      weekdays: [1, 3, 5],
      window: { start: "09:00", end: "17:00" },
      endsAt: new Date(2026, 8, 30, 23, 59, 59, 999).getTime(),
    }, occurrence, moved)).toEqual({
      type: "interval",
      everyMinutes: 30,
      anchorAt: new Date(2026, 7, 31, 10, 30).getTime(),
      weekdays: [1, 3, 5],
      window: { start: "09:00", end: "17:00" },
      endsAt: new Date(2026, 8, 30, 23, 59, 59, 999).getTime(),
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

  it("packs adjacent five minute events around their minimum visual height", () => {
    const at = new Date(2026, 7, 31, 9).getTime();
    const layouts = packCalendarCollisions([
      { id: "one", at, durationMinutes: 5 },
      { id: "two", at: at + 5 * 60_000, durationMinutes: 5 },
    ]);

    expect(layouts.get("one")).toEqual({ column: 0, columns: 2 });
    expect(layouts.get("two")).toEqual({ column: 1, columns: 2 });
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
      target: "bot",
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
        target: "bot",
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

  it("shows one next interval occurrence instead of filling the calendar", () => {
    const from = new Date(2026, 7, 31, 9).getTime();
    const receiptAt = from;
    const routine: Routine = {
      id: "interval-routine",
      name: "Pulse",
      prompt: "Check status",
      target: "bot",
      botId: "b1",
      runOn: "maus",
      enabled: true,
      schedule: { type: "interval", everyMinutes: 5, anchorAt: from },
      durationMinutes: 30,
      nextRunAt: from + 5 * 60_000,
      createdAt: from,
      updatedAt: from,
    };
    const items = projectedRoutineItems(
      [routine],
      [{
        id: "interval-run",
        routineId: routine.id,
        routineName: routine.name,
        target: "bot",
        botId: routine.botId,
        runOn: "maus",
        scheduledFor: receiptAt,
        status: "completed",
        manual: false,
        createdAt: receiptAt,
      }],
      from,
      from + 60 * 60_000,
    );

    expect(items).toHaveLength(2);
    expect(items[0]?.run?.id).toBe("interval-run");
    expect(items[1]?.at).toBe(from + 5 * 60_000);
    expect(items[1]?.run).toBeNull();
  });

  it("does not resurrect an interval occurrence the scheduler skipped", () => {
    const from = new Date(2026, 7, 31, 9).getTime();
    const routine: Routine = {
      id: "interval-routine",
      name: "Pulse",
      prompt: "Check status",
      target: "bot",
      botId: "b1",
      runOn: "maus",
      enabled: true,
      schedule: { type: "interval", everyMinutes: 5, anchorAt: from },
      durationMinutes: 30,
      nextRunAt: from + 15 * 60_000,
      createdAt: from,
      updatedAt: from,
    };

    const items = projectedRoutineItems([routine], [], from, from + 60 * 60_000);

    expect(items.map((item) => item.at)).toEqual([from + 15 * 60_000]);
  });

  it("caps dense interval receipts so a week view stays responsive", () => {
    const from = new Date(2026, 7, 31, 9).getTime();
    const routine: Routine = {
      id: "interval-routine",
      name: "Pulse",
      prompt: "Check status",
      target: "bot",
      botId: "b1",
      runOn: "maus",
      enabled: false,
      schedule: { type: "interval", everyMinutes: 5, anchorAt: from },
      durationMinutes: 30,
      nextRunAt: null,
      createdAt: from,
      updatedAt: from,
    };
    const runs: RoutineRun[] = Array.from({ length: 100 }, (_, index) => ({
      id: `run-${index}`,
      routineId: routine.id,
      routineName: routine.name,
      target: "bot",
      botId: routine.botId,
      runOn: "maus",
      scheduledFor: from + index * 5 * 60_000,
      status: "completed",
      manual: false,
      createdAt: from + index * 5 * 60_000,
    }));

    const items = projectedRoutineItems([routine], runs, from, from + 24 * 60 * 60_000);

    expect(items).toHaveLength(12);
    expect(items.at(-1)?.at).toBe(from + 99 * 5 * 60_000);
  });

  it("keeps queued, running, and waiting receipts outside the terminal history cap", () => {
    const from = new Date(2026, 7, 31, 9).getTime();
    const terminalRuns: RoutineRun[] = Array.from({ length: 20 }, (_, index) => ({
      id: `completed-run-${index}`,
      routineId: "interval-routine",
      routineName: "Pulse",
      target: "bot",
      botId: "b1",
      runOn: "maus",
      scheduledFor: from + (index + 3) * 5 * 60_000,
      status: "completed",
      manual: false,
      createdAt: from + (index + 3) * 5 * 60_000,
    }));
    const activeRuns: RoutineRun[] = (["queued", "running", "waiting"] as const).map((status, index) => ({
      id: `${status}-run`,
      routineId: "interval-routine",
      routineName: "Pulse",
      target: "bot",
      botId: "b1",
      runOn: "maus",
      scheduledFor: from + index * 5 * 60_000,
      status,
      manual: false,
      createdAt: from + index * 5 * 60_000,
    }));

    const items = projectedRoutineItems(
      [],
      [...activeRuns, ...terminalRuns],
      from,
      from + 24 * 60 * 60_000,
    );

    expect(items.filter((item) => item.run?.status === "completed")).toHaveLength(12);
    expect(items.filter((item) => item.run?.status === "queued")).toHaveLength(1);
    expect(items.filter((item) => item.run?.status === "running")).toHaveLength(1);
    expect(items.filter((item) => item.run?.status === "waiting")).toHaveLength(1);
  });

  it("keeps dense history bounded after its routine is deleted", () => {
    const from = new Date(2026, 7, 31, 9).getTime();
    const runs: RoutineRun[] = Array.from({ length: 100 }, (_, index) => ({
      id: `orphaned-run-${index}`,
      routineId: "deleted-interval-routine",
      routineName: "Deleted pulse",
      target: "bot",
      botId: "b1",
      runOn: "maus",
      scheduledFor: from + index * 5 * 60_000,
      status: "completed",
      manual: false,
      createdAt: from + index * 5 * 60_000,
    }));

    const items = projectedRoutineItems([], runs, from, from + 24 * 60 * 60_000);

    expect(items).toHaveLength(12);
    expect(items.at(-1)?.at).toBe(from + 99 * 5 * 60_000);
  });
});
