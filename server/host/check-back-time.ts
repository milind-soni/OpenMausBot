// When a check-back is due, from a bot's `when`: an exact time with its offset, a span from now ("in 2 hours"), or a day
// and a time in the person's zone ("Friday 9am", "tomorrow 16:00"). Wall-clock times follow the routine rules: a time a
// clock change skips moves forward through the gap, and a time a clock change repeats is its first occurrence.

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const WEEKDAY_SHORT: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const UNITS: Record<string, number> = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: DAY, day: DAY, days: DAY,
  w: 7 * DAY, wk: 7 * DAY, wks: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY,
};
const NAMED_TIMES: Record<string, [number, number]> = { noon: [12, 0], midday: [12, 0], midnight: [0, 0], morning: [9, 0], afternoon: [14, 0], evening: [18, 0], tonight: [20, 0] };
/** A day named without a time: the start of a working day. */
const DEFAULT_TIME: [number, number] = [9, 0];

export const WHEN_HELP = 'when: "in 2 hours", "tomorrow 9am", "Friday 16:00", or an exact time such as 2026-11-21T09:00:00+01:00.';

export type WhenResult = { ok: true; at: number } | { ok: false; error: string };

interface Wall { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    formatters.set(zone, found);
  }
  return found;
}

export function validZone(zone: string): boolean {
  try { formatter(zone); return true; } catch { return false; }
}

function wallOf(ms: number, zone: string): Wall & { second: number } {
  const parts = Object.fromEntries(formatter(zone).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute),
    second: Number(parts.second), weekday: WEEKDAY_SHORT[String(parts.weekday).toLowerCase()] ?? 0,
  };
}

const asUtc = (wall: Pick<Wall, "year" | "month" | "day" | "hour" | "minute"> & { second?: number }) =>
  Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0);

function offsetAt(ms: number, zone: string): number {
  return asUtc(wallOf(ms, zone)) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time in `zone` names: the first of two in a repeated hour, moved forward through a skipped one. */
export function zonedInstant(wall: Pick<Wall, "year" | "month" | "day" | "hour" | "minute">, zone: string): number {
  const target = asUtc({ year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute });
  const before = offsetAt(target - DAY, zone), after = offsetAt(target + DAY, zone);
  const fits = [target - before, target - after].filter((at) => asUtc(wallOf(at, zone)) === target);
  return fits.length ? Math.min(...fits) : target - before;
}

function addDays(wall: Wall, days: number): Wall {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { ...wall, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

function parseDuration(text: string): number | null {
  const words = text.replace(/\bfrom now\b/, "").replace(/\band\b|,/g, " ").trim();
  if (!words) return null;
  let total = 0, rest = words;
  const half = /^half an? hour\b\s*/;
  while (rest) {
    if (half.test(rest)) { total += 30 * MINUTE; rest = rest.replace(half, ""); continue; }
    const match = /^(\d+(?:\.\d+)?|an?)\s*([a-z]+)\s*/.exec(rest);
    const unit = match ? UNITS[match[2]!] : undefined;
    if (!match || unit === undefined) return null;
    total += (match[1] === "a" || match[1] === "an" ? 1 : Number(match[1])) * unit;
    rest = rest.slice(match[0].length);
  }
  return total > 0 ? Math.round(total) : null;
}

function parseClock(text: string): [number, number] | null {
  const named = NAMED_TIMES[text];
  if (named) return named;
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const half = match[3]?.replace(/\./g, "");
  if (!half && !match[2] && text.length > 2) return null;
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === "pm" ? 12 : 0);
  } else if (hour > 23) return null;
  return [hour, minute];
}

type DayWord = { kind: "today" } | { kind: "tomorrow" } | { kind: "weekday"; weekday: number; next: boolean } | { kind: "date"; year: number; month: number; day: number };

function parseDay(text: string): DayWord | null {
  if (text === "today" || text === "tonight" || text === "this evening" || text === "this afternoon" || text === "this morning") return { kind: "today" };
  if (text === "tomorrow") return { kind: "tomorrow" };
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (date) return { kind: "date", year: Number(date[1]), month: Number(date[2]), day: Number(date[3]) };
  const weekday = /^(?:(next|this|on)\s+)?([a-z]+)$/.exec(text);
  if (!weekday) return null;
  const name = weekday[2]!;
  const full = WEEKDAYS.findIndex((day) => day === name);
  const index = full >= 0 ? full : WEEKDAY_SHORT[name];
  return index === undefined ? null : { kind: "weekday", weekday: index, next: weekday[1] === "next" };
}

const DAY_PART: Record<string, string> = { tonight: "tonight", "this evening": "evening", "this afternoon": "afternoon", "this morning": "morning" };

function dayAndTime(text: string, now: number, zone: string): number | null {
  const at = text.replace(/\s+at\s+/, " ").replace(/^at\s+/, "").trim();
  const tokens = at.split(/\s+/);
  for (let split = 0; split <= tokens.length; split++) {
    for (const [dayText, clockText] of [[tokens.slice(0, split).join(" "), tokens.slice(split).join(" ")], [tokens.slice(split).join(" "), tokens.slice(0, split).join(" ")]] as const) {
      const day = dayText ? parseDay(dayText) : null;
      if (dayText && !day) continue;
      const clock = clockText ? parseClock(clockText) : DAY_PART[dayText] ? NAMED_TIMES[DAY_PART[dayText]!]! : null;
      if (clockText && !clock) continue;
      if (!day && !clock) continue;
      return resolveDay(day, clock, now, zone);
    }
  }
  return null;
}

function realDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function resolveDay(day: DayWord | null, clock: [number, number] | null, now: number, zone: string): number | null {
  const today = wallOf(now, zone);
  const [hour, minute] = clock ?? DEFAULT_TIME;
  const on = (wall: Pick<Wall, "year" | "month" | "day">) => zonedInstant({ ...wall, hour, minute }, zone);
  if (!day) {
    const first = on(today);
    return first > now ? first : on(addDays(today, 1));
  }
  if (day.kind === "today") return on(today);
  if (day.kind === "tomorrow") return on(addDays(today, 1));
  if (day.kind === "date") return realDate(day.year, day.month, day.day) ? on(day) : null;
  let ahead = (day.weekday - today.weekday + 7) % 7;
  if (day.next && ahead === 0) ahead = 7;
  const candidate = on(addDays(today, ahead));
  return candidate > now ? candidate : on(addDays(today, ahead + 7));
}

const EXACT = /^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(z|[+-]\d{2}:?\d{2})?$/;

/** The time `when` names, in `zone` where it names a wall-clock time; an error the bot can act on otherwise. */
export function parseWhen(when: string, now: number, zone: string): WhenResult {
  const text = when.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]$/, "");
  if (!text) return { ok: false, error: WHEN_HELP };
  const exact = EXACT.exec(text);
  if (exact) {
    const [, y, mo, d, h, mi, s, offset] = exact;
    if (!realDate(Number(y), Number(mo), Number(d)) || Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59) return { ok: false, error: WHEN_HELP };
    const at = offset
      ? Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}${offset === "z" ? "Z" : offset.length === 5 ? `${offset.slice(0, 3)}:${offset.slice(3)}` : offset}`)
      : zonedInstant({ year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi) }, zone);
    return Number.isFinite(at) ? { ok: true, at } : { ok: false, error: WHEN_HELP };
  }
  const relative = /^(?:in |after )(.+)$/.exec(text)?.[1] ?? (/\bfrom now$/.test(text) ? text : null);
  if (relative) {
    const span = parseDuration(relative);
    return span === null ? { ok: false, error: WHEN_HELP } : { ok: true, at: now + span };
  }
  const at = dayAndTime(text, now, zone);
  return at === null ? { ok: false, error: WHEN_HELP } : { ok: true, at };
}

/** "Fri 21 Nov 09:00" in `zone`, for the bot's answer and the line's English words. */
export function wallClockLabel(at: number, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(at)).replace(",", "");
}
