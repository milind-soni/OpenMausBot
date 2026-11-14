// When an interval routine may run: its days, its hours and its end, read in this computer's local time. Moved out of
// routines.ts unchanged.
import type { RoutineIntervalSchedule } from "./routine-schedules.ts";

export const MAX_DATE_MS = 8_640_000_000_000_000;
const LOCAL_DAY_MS = 24 * 60 * 60_000;
export const INTERVAL_RESTRICTION_SEARCH_MS = 9 * LOCAL_DAY_MS;
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function clockMinutes(value: string): number | null {
  const match = CLOCK_TIME.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function intervalHasRestrictions(
  schedule: Pick<RoutineIntervalSchedule, "weekdays" | "window" | "endsAt">,
): boolean {
  return schedule.weekdays !== undefined || schedule.window !== undefined || schedule.endsAt !== undefined;
}

export function intervalAllowsOccurrence(schedule: RoutineIntervalSchedule, at: number): boolean {
  if (schedule.endsAt !== undefined && at > schedule.endsAt) return false;
  const date = new Date(at);
  if (schedule.weekdays && !schedule.weekdays.includes(date.getDay())) return false;
  if (schedule.window) {
    const minute = date.getHours() * 60 + date.getMinutes();
    const start = clockMinutes(schedule.window.start)!;
    const end = clockMinutes(schedule.window.end)!;
    if (minute < start || minute >= end) return false;
  }
  return true;
}

export function isSameLocalDay(left: number, right: number): boolean {
  const a = new Date(left);
  const b = new Date(right);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function nextAlignedInterval(schedule: RoutineIntervalSchedule, after: number): number | null {
  if (schedule.anchorAt > after) return schedule.anchorAt;
  const intervalMs = schedule.everyMinutes * 60_000;
  const intervalsElapsed = Math.floor((after - schedule.anchorAt) / intervalMs);
  const candidate = schedule.anchorAt + (intervalsElapsed + 1) * intervalMs;
  return Number.isSafeInteger(candidate) && candidate <= MAX_DATE_MS ? candidate : null;
}

export function latestIntervalOccurrence(
  schedule: RoutineIntervalSchedule,
  at: number,
): number | null {
  const intervalMs = schedule.everyMinutes * 60_000;
  const ceiling = Math.min(at, schedule.endsAt ?? at);
  if (schedule.anchorAt > ceiling) return null;
  let candidate = schedule.anchorAt + Math.floor((ceiling - schedule.anchorAt) / intervalMs) * intervalMs;
  if (!intervalHasRestrictions(schedule)) return candidate;
  const maxCandidates = Math.ceil(INTERVAL_RESTRICTION_SEARCH_MS / intervalMs) + 2;
  for (let checked = 0; checked < maxCandidates; checked++) {
    if (intervalAllowsOccurrence(schedule, candidate)) return candidate;
    const previous = candidate - intervalMs;
    if (!Number.isSafeInteger(previous) || previous < schedule.anchorAt) return null;
    candidate = previous;
  }
  return null;
}
