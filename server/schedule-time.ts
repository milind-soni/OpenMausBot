import type { ScheduleRepeat } from "./schedule-types.ts";
const minute = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string) {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (formatters.size > 100) formatters.clear();
    formatters.set(timezone, value);
  }
  return value;
}
function parts(at: number, timezone: string) {
  const p = Object.fromEntries(formatter(timezone).formatToParts(at).map(p => [p.type, p.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute };
}
/** Earlier occurrence for a folded clock time; advance by the DST gap for a missing time. */
export function localInstant(date: string, time: string, timezone: string): string {
  formatter(timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Choose a valid date and time.");
  const target = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== date) throw new Error("Choose a valid date.");
  const offsets = new Set<number>();
  for (let delta = -36; delta <= 36; delta += 6) {
    const at = target + delta * 3_600_000, p = parts(at, timezone);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - at);
  }
  const candidates = [...offsets].map(offset => target - offset).map(at => {
    const p = parts(at, timezone);
    return { at, wall: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) };
  });
  const exact = candidates.filter(c => c.wall === target).sort((a, b) => a.at - b.at)[0];
  const forward = candidates.filter(c => c.wall > target).sort((a, b) => a.wall - b.wall || a.at - b.at)[0];
  if (!exact && !forward) throw new Error("That time is not available in this timezone.");
  return new Date((exact ?? forward).at).toISOString();
}
/** Strictly after `after`, anchored intervals; one occurrence per local calendar day. */
export function nextScheduleRun(repeat: ScheduleRepeat, timezone: string, after: number, anchor = after): string | null {
  formatter(timezone);
  if (repeat.kind === "once") return Date.parse(repeat.at) > after ? new Date(repeat.at).toISOString() : null;
  if (repeat.kind === "every") {
    const interval = repeat.hours * 60 * minute;
    const steps = Math.max(1, Math.floor((after - anchor) / interval) + 1);
    return new Date(anchor + steps * interval).toISOString();
  }
  const p = parts(after, timezone), start = Date.UTC(p.year, p.month - 1, p.day);
  for (let day = 0; day <= 8; day++) {
    const date = new Date(start + day * 86400_000), weekday = date.getUTCDay();
    if (repeat.kind === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (repeat.kind === "weekly" && !repeat.days.includes(weekday)) continue;
    const at = localInstant(date.toISOString().slice(0, 10), repeat.time, timezone);
    if (Date.parse(at) > after) return at;
  }
  throw new Error("Choose at least one day.");
}
/** Latest occurrence at or before now, used to catch up once without replaying a backlog. */
export function latestScheduleRun(repeat: ScheduleRepeat, timezone: string, now: number, anchor: number): string | null {
  formatter(timezone);
  if (repeat.kind === "once") return Date.parse(repeat.at) <= now ? new Date(repeat.at).toISOString() : null;
  if (repeat.kind === "every") {
    const interval = repeat.hours * 3600_000, steps = Math.floor((now - anchor) / interval);
    return steps >= 1 ? new Date(anchor + steps * interval).toISOString() : null;
  }
  const p = parts(now, timezone), start = Date.UTC(p.year, p.month - 1, p.day);
  for (let day = 0; day <= 8; day++) {
    const date = new Date(start - day * 86400_000), weekday = date.getUTCDay();
    if (repeat.kind === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (repeat.kind === "weekly" && !repeat.days.includes(weekday)) continue;
    const at = localInstant(date.toISOString().slice(0, 10), repeat.time, timezone);
    if (Date.parse(at) <= now) return at;
  }
  return null;
}
export const resumeDelay = (attempt: number) => Math.min(360, 15 * 2 ** Math.min(10, Math.max(0, attempt))) * minute;
