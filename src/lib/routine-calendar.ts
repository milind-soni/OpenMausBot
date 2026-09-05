import type { Routine, RoutineRun, RoutineSchedule } from "./routines";

export const CALENDAR_SLOT_MINUTES = 5;
const ROUTINE_MARKER_MINUTES = 30;
const MAX_RECEIPTS_PER_ROUTINE_PER_RANGE = 12;

export type RoutineCalendarItem = {
  id: string;
  at: number;
  durationMinutes: number;
  routine: Routine | null;
  run: RoutineRun | null;
};

export type CalendarCollisionItem = {
  id: string;
  at: number;
  durationMinutes: number;
};

export type CalendarCollisionLayout = {
  column: number;
  columns: number;
};

export function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function addDays(at: number, days: number): number {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function startOfWeek(at: number): number {
  const date = new Date(startOfDay(at));
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
}

export function atLocalTime(day: number, time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  const date = new Date(day);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

export function toLocalDateInput(at: number): string {
  const date = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 10);
}

export function toLocalTimeInput(at: number): string {
  const date = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(11, 16);
}

export function fromLocalDateAndTime(date: string, time: string): number {
  return new Date(`${date}T${time}`).getTime();
}

/** Start a new interval at least one full cadence from now, on a clean minute boundary. */
export function nextIntervalAnchor(now: number, everyMinutes: number): number {
  return Math.ceil((now + everyMinutes * 60_000) / 60_000) * 60_000;
}

export function intervalAnchorForSave(
  now: number,
  everyMinutes: number,
  current?: { everyMinutes: number; anchorAt: number },
): number {
  return current?.everyMinutes === everyMinutes
    ? current.anchorAt
    : nextIntervalAnchor(now, everyMinutes);
}

export function snapMinutes(minutes: number, increment = CALENDAR_SLOT_MINUTES): number {
  return Math.max(0, Math.min(24 * 60 - increment, Math.round(minutes / increment) * increment));
}

/**
 * Assign overlapping events to stable, side-by-side columns. Adjacent events can
 * reuse a column, while overlap chains share one column count so cards never
 * cover each other as a cluster grows.
 */
export function packCalendarCollisions(
  items: readonly CalendarCollisionItem[],
): Map<string, CalendarCollisionLayout> {
  // Short events keep a 16px hit target in the renderer. Pack against that
  // same visual footprint so adjacent five-minute cards never cover each other.
  const visualEnd = (item: CalendarCollisionItem) =>
    item.at + Math.max(15, item.durationMinutes) * 60_000;
  const sorted = [...items].sort((left, right) =>
    left.at - right.at
    || visualEnd(left) - visualEnd(right)
    || left.id.localeCompare(right.id),
  );
  const result = new Map<string, CalendarCollisionLayout>();

  for (let cursor = 0; cursor < sorted.length;) {
    const cluster: CalendarCollisionItem[] = [];
    let clusterEnd = sorted[cursor]!.at;
    while (cursor < sorted.length) {
      const item = sorted[cursor]!;
      if (cluster.length > 0 && item.at >= clusterEnd) break;
      cluster.push(item);
      clusterEnd = Math.max(clusterEnd, visualEnd(item));
      cursor += 1;
    }

    const columnEnds: number[] = [];
    const assignments = cluster.map((item) => {
      const available = columnEnds.findIndex((end) => end <= item.at);
      const column = available === -1 ? columnEnds.length : available;
      columnEnds[column] = visualEnd(item);
      return { id: item.id, column };
    });
    const columns = Math.max(1, columnEnds.length);
    for (const assignment of assignments) {
      result.set(assignment.id, { column: assignment.column, columns });
    }
  }

  return result;
}

/** Format a local UTC offset in the compact style used by calendar gutters. */
export function formatGmtOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "GMT+0";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `GMT${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

export function slotAt(day: number, clientY: number, top: number, hourHeight: number): number {
  const minutes = snapMinutes(((clientY - top) / hourHeight) * 60);
  const date = new Date(day);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date.getTime();
}

export function scheduleAt(schedule: RoutineSchedule, occurrenceAt: number, nextAt: number): RoutineSchedule {
  if (schedule.type === "once") return { type: "once", at: nextAt };
  if (schedule.type === "interval") {
    return {
      ...schedule,
      anchorAt: schedule.anchorAt + (nextAt - occurrenceAt),
    };
  }
  const dayDelta = Math.round((startOfDay(nextAt) - startOfDay(occurrenceAt)) / 86_400_000);
  return {
    type: "daily",
    time: toLocalTimeInput(nextAt),
    weekdays: schedule.weekdays.map((weekday) => ((weekday + dayDelta) % 7 + 7) % 7).sort(),
  };
}

export function projectedRoutineItems(
  routines: Routine[],
  runs: RoutineRun[],
  from: number,
  to: number,
): RoutineCalendarItem[] {
  const routineById = new Map(routines.map((routine) => [routine.id, routine]));
  const receiptCounts = new Map<string, number>();
  const visibleRuns = runs
    .filter((run) => run.scheduledFor >= from && run.scheduledFor < to)
    .sort((left, right) => right.scheduledFor - left.scheduledFor)
    .filter((run) => {
      if (run.status === "queued" || run.status === "running" || run.status === "waiting") {
        return true;
      }
      // A routine may later be edited or deleted, so the current definition
      // cannot safely tell us whether its history came from a dense interval.
      // Keep active receipts unbounded above, while trimming terminal history.
      const count = receiptCounts.get(run.routineId) ?? 0;
      if (count >= MAX_RECEIPTS_PER_ROUTINE_PER_RANGE) return false;
      receiptCounts.set(run.routineId, count + 1);
      return true;
    });
  const items: RoutineCalendarItem[] = visibleRuns
    .map((run) => ({
      id: `run-${run.id}`,
      at: run.scheduledFor,
      durationMinutes: ROUTINE_MARKER_MINUTES,
      routine: routineById.get(run.routineId) ?? null,
      run,
    }));

  const hasReceipt = (routineId: string, at: number) =>
    runs.some((run) => run.routineId === routineId && Math.abs(run.scheduledFor - at) < 60_000);

  for (const routine of routines) {
    if (!routine.enabled) continue;
    if (routine.schedule.type === "once") {
      const at = routine.schedule.at;
      if (at >= from && at < to && !hasReceipt(routine.id, at)) {
        items.push({
          id: `next-${routine.id}-${at}`,
          at,
          durationMinutes: ROUTINE_MARKER_MINUTES,
          routine,
          run: null,
        });
      }
      continue;
    }
    if (routine.schedule.type === "interval") {
      // The scheduler deliberately skips overlapping and stale interval ticks.
      // Its persisted nextRunAt is the only future occurrence users can act on;
      // reconstructing an unreceipted tick would resurrect work it skipped.
      const at = routine.nextRunAt;
      if (at != null && at >= from && at < to && !hasReceipt(routine.id, at)) {
        items.push({
          id: `next-${routine.id}-${at}`,
          at,
          durationMinutes: ROUTINE_MARKER_MINUTES,
          routine,
          run: null,
        });
      }
      continue;
    }
    for (let day = startOfDay(from); day < to; day = addDays(day, 1)) {
      if (!routine.schedule.weekdays.includes(new Date(day).getDay())) continue;
      const at = atLocalTime(day, routine.schedule.time);
      if (at >= from && at < to && at >= routine.createdAt && !hasReceipt(routine.id, at)) {
        items.push({
          id: `next-${routine.id}-${at}`,
          at,
          durationMinutes: ROUTINE_MARKER_MINUTES,
          routine,
          run: null,
        });
      }
    }
  }
  return items.sort((left, right) => left.at - right.at);
}

export function calendarRangeLabel(from: number, days: number): string {
  const to = addDays(from, days - 1);
  const start = new Date(from);
  const end = new Date(to);
  if (days === 1) {
    return start.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
  }
  if (start.getMonth() === end.getMonth()) {
    return `${start.toLocaleDateString([], { month: "long" })} ${start.getDate()} – ${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${start.toLocaleDateString([], { month: "short", day: "numeric" })} – ${end.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
}
