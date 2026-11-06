import { atLocalTime } from "@/lib/routine-calendar";
import type { RoutineSchedule } from "@/lib/routines";
import { cronScheduleLabel } from "../../shared/cron-label";
import { cronText } from "@/lib/cron-text";
import { clockOptions } from "@/lib/clock-time";
import { limitResetWhen } from "@/lib/limit-resets";
import { intlLocale, t } from "@/lib/i18n";

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function dayName(day: number): string {
  return new Date(2026, 0, 4 + day).toLocaleDateString(intlLocale(), { weekday: "short" });
}

export function niceTime(at: number): string {
  return new Date(at).toLocaleTimeString(intlLocale(), clockOptions(intlLocale()));
}

export function niceDate(at: number): string {
  return new Date(at).toLocaleDateString(intlLocale(), { weekday: "long", month: "long", day: "numeric" });
}

export function whenLabel(at: number): string {
  const date = new Date(at);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay ? niceTime(at) : date.toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return t("routines.duration.minutes", { minutes });
  if (minutes % 60 === 0) return t("routines.duration.hours", { hours: minutes / 60 });
  return t("routines.duration.hoursMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

export function intervalLabel(minutes: number): string {
  if (minutes < 60) return t("routines.interval.minutes", { minutes });
  if (minutes === 60) return t("routines.interval.hour");
  if (minutes % 60 === 0) return t("routines.interval.hours", { hours: minutes / 60 });
  return t("routines.interval.hoursMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

function intervalRestrictions(schedule: Extract<RoutineSchedule, { type: "interval" }>): string[] {
  const details: string[] = [];
  if (schedule.weekdays && schedule.weekdays.length < 7) {
    details.push(schedule.weekdays.join(",") === "1,2,3,4,5"
      ? t("routines.schedule.weekdays")
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
    details.push(t("routines.schedule.until", { date: new Date(schedule.endsAt).toLocaleDateString(intlLocale(), { month: "short", day: "numeric", year: "numeric" }) }));
  }
  return details;
}

export function scheduleLabel(schedule: RoutineSchedule | { type: "once"; at: number } | { type: "daily"; time: string; weekdays: number[] }): string {
  if (schedule.type === "cron") return cronText(schedule);
  if (schedule.type === "limit_reset") return limitResetWhen(schedule);
  if (schedule.type === "once") return `${niceDate(schedule.at)}, ${niceTime(schedule.at)}`;
  if (schedule.type === "interval") {
    return [intervalLabel(schedule.everyMinutes), ...intervalRestrictions(schedule)].join(" · ");
  }
  const days = schedule.weekdays;
  const label = days.length === 7
    ? t("routines.repeat.daily")
    : days.join(",") === "1,2,3,4,5"
      ? t("routines.schedule.everyWeekday")
      : days.length === 1
        ? t("routines.schedule.weeklyOn", { day: dayName(days[0]!) })
        : days.map(dayName).join(", ");
  return t("routines.schedule.at", { label, time: niceTime(atLocalTime(Date.now(), schedule.time)) });
}

export function scheduleSentence(schedule: RoutineSchedule): string {
  if (schedule.type === "cron") return cronScheduleLabel(schedule);
  if (schedule.type === "limit_reset") return limitResetWhen(schedule).toLocaleLowerCase();
  if (schedule.type === "interval") {
    const label = intervalLabel(schedule.everyMinutes);
    const lowercase = label.replace(/^Every /, "every ");
    const withMinutes = lowercase.replace(/(\d+) min(?!ute)/g, "$1 minutes");
    const cadence = withMinutes.replace(/(\d+) hr(?!our)/g, (_match, num) => {
      return num === "1" ? "1 hour" : `${num} hours`;
    });
    return [cadence, ...intervalRestrictions(schedule)].join(" · ");
  }
  if (schedule.type === "once") {
    return `once on ${niceDate(schedule.at)}, ${niceTime(schedule.at)}`;
  }
  const days = schedule.weekdays;
  const timeStr = niceTime(atLocalTime(Date.now(), schedule.time));

  if (days.length === 7) {
    return `every day at ${timeStr}`;
  }
  if (days.join(",") === "1,2,3,4,5") {
    return `every weekday at ${timeStr}`;
  }
  if (days.length === 1) {
    return `weekly on ${DAY_NAMES[days[0]!]} at ${timeStr}`;
  }

  return `${days.map((day) => DAY_NAMES[day]).join(", ")} at ${timeStr}`;
}
