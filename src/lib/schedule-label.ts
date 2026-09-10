import { activeLocale, t } from "@/lib/i18n";
import { atLocalTime } from "@/lib/routine-calendar";
import type { RoutineSchedule } from "@/lib/routines";

/** Weekday abbreviations, shared with the computer panel's schedule summary —
 * a short day name reads the same wherever it appears. */
const DAY_KEYS = [
  "computer.day.sun",
  "computer.day.mon",
  "computer.day.tue",
  "computer.day.wed",
  "computer.day.thu",
  "computer.day.fri",
  "computer.day.sat",
] as const;

/** Resolve on every call: a module-scope array of resolved names would keep
 * the language the app booted in. */
export function dayName(day: number): string {
  return t(DAY_KEYS[day] ?? "computer.day.sun");
}

/** A Sunday-indexed reference week — 2021-08-01 was a Sunday — so a weekday
 * name can be formatted without a real date in hand. */
function weekdayDate(day: number): Date {
  return new Date(Date.UTC(2021, 7, 1 + (((day % 7) + 7) % 7)));
}

/** The one- or two-character label for a day chip. Never slice a translated
 * day name for this: every Chinese weekday starts with 周, so all seven chips
 * would read alike. Intl has a narrow form for each language. */
export function dayNarrow(day: number): string {
  return new Intl.DateTimeFormat(activeLocale(), { weekday: "narrow", timeZone: "UTC" }).format(weekdayDate(day));
}

/** The full day name, for the accessible label a narrow chip needs. */
export function dayFull(day: number): string {
  return new Intl.DateTimeFormat(activeLocale(), { weekday: "long", timeZone: "UTC" }).format(weekdayDate(day));
}

export function niceTime(at: number): string {
  return new Date(at).toLocaleTimeString(activeLocale(), { hour: "numeric", minute: "2-digit" });
}

export function niceDate(at: number): string {
  return new Date(at).toLocaleDateString(activeLocale(), { weekday: "long", month: "long", day: "numeric" });
}

/** A change's timestamp for a list row: the time alone if it happened
 * today, else the date — one rule shared by the Overview's recent-changes
 * card and the History section so the same row never reads two ways. */
export function whenLabel(at: number): string {
  const date = new Date(at);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay ? niceTime(at) : date.toLocaleDateString(activeLocale(), { month: "short", day: "numeric" });
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return t("schedule.durationMin", { count: minutes });
  if (minutes % 60 === 0) return t("schedule.durationHr", { count: minutes / 60 });
  return t("schedule.durationHrMin", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

export function intervalLabel(minutes: number): string {
  if (minutes < 60) return t("schedule.everyMin", { count: minutes });
  if (minutes === 60) return t("schedule.everyHour");
  if (minutes % 60 === 0) return t("schedule.everyHr", { count: minutes / 60 });
  return t("schedule.everyHrMin", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** Weekday, time-window and end-date limits an interval schedule can carry.
 * Same pieces main renders, each resolved through the catalog. */
function intervalRestrictions(schedule: Extract<RoutineSchedule, { type: "interval" }>): string[] {
  const details: string[] = [];
  if (schedule.weekdays && schedule.weekdays.length < 7) {
    details.push(schedule.weekdays.join(",") === "1,2,3,4,5"
      ? t("schedule.restriction.weekdays")
      : schedule.weekdays.map(dayName).join(", "));
  }
  if (schedule.window) {
    const wallTime = (time: string) => {
      const [hour, minute] = time.split(":").map(Number);
      return niceTime(new Date(2000, 0, 1, hour, minute).getTime());
    };
    details.push(`${wallTime(schedule.window.start)}–${wallTime(schedule.window.end)}`);
  }
  if (schedule.endsAt != null) {
    details.push(t("schedule.restriction.until", {
      date: new Date(schedule.endsAt).toLocaleDateString(activeLocale(), { month: "short", day: "numeric", year: "numeric" }),
    }));
  }
  return details;
}

export function scheduleLabel(schedule: RoutineSchedule | { type: "once"; at: number } | { type: "daily"; time: string; weekdays: number[] }): string {
  if (schedule.type === "once") {
    return t("schedule.onceAt", { date: niceDate(schedule.at), time: niceTime(schedule.at) });
  }
  if (schedule.type === "interval") {
    return [intervalLabel(schedule.everyMinutes), ...intervalRestrictions(schedule)].join(" · ");
  }
  const days = schedule.weekdays;
  const label = days.length === 7
    ? t("schedule.everyDay")
    : days.join(",") === "1,2,3,4,5"
      ? t("schedule.everyWeekday")
      : days.length === 1
        ? t("schedule.weeklyOn", { day: dayName(days[0]!) })
        : days.map(dayName).join(", ");
  return t("schedule.atTime", { label, time: niceTime(atLocalTime(Date.now(), schedule.time)) });
}

/** "5 minutes", "1 hour", "2 hours 30 minutes" — the span an interval repeats
 * over, assembled from keys rather than rewritten from the short label. */
function intervalSpan(minutes: number): string {
  if (minutes < 60) return t("schedule.sentence.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursPart = hours === 1
    ? t("schedule.sentence.hourOne")
    : t("schedule.sentence.hourMany", { count: hours });
  return rest === 0 ? hoursPart : `${hoursPart} ${t("schedule.sentence.minutes", { count: rest })}`;
}

export function scheduleSentence(schedule: RoutineSchedule): string {
  if (schedule.type === "interval") {
    const cadence = schedule.everyMinutes === 60
      ? t("schedule.sentence.everyHour")
      : t("schedule.sentence.every", { span: intervalSpan(schedule.everyMinutes) });
    return [cadence, ...intervalRestrictions(schedule)].join(" · ");
  }
  if (schedule.type === "once") {
    return t("schedule.sentence.once", { date: niceDate(schedule.at), time: niceTime(schedule.at) });
  }
  const days = schedule.weekdays;
  const time = niceTime(atLocalTime(Date.now(), schedule.time));
  if (days.length === 7) return t("schedule.sentence.everyDayAt", { time });
  if (days.join(",") === "1,2,3,4,5") return t("schedule.sentence.everyWeekdayAt", { time });
  if (days.length === 1) return t("schedule.sentence.weeklyOnAt", { day: dayName(days[0]!), time });
  return t("schedule.sentence.daysAt", { days: days.map(dayName).join(", "), time });
}
