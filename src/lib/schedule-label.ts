import { atLocalTime } from "@/lib/routine-calendar";
import type { RoutineSchedule } from "@/lib/routines";
import { cronScheduleLabel } from "../../shared/cron-label";
import { limitResetWhen } from "@/lib/limit-resets";
import { activeLocale, t } from "@/lib/i18n";

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function dayNames(width: "short" | "narrow" | "chip" = "short"): string[] {
  if (activeLocale() === "en") return DAY_NAMES.map((day) => width === "short" ? day : day.slice(0, width === "chip" ? 2 : 1));
  const format = new Intl.DateTimeFormat(activeLocale(), { weekday: width === "short" ? "short" : "narrow", timeZone: "UTC" });
  return DAY_NAMES.map((_, day) => format.format(new Date(Date.UTC(2026, 0, 4 + day))));
}

function calendarLocale(): string | undefined {
  return activeLocale() === "en" ? undefined : activeLocale();
}

export function niceTime(at: number): string {
  return new Date(at).toLocaleTimeString(calendarLocale(), { hour: "numeric", minute: "2-digit" });
}

export function niceDate(at: number): string {
  return new Date(at).toLocaleDateString(calendarLocale(), { weekday: "long", month: "long", day: "numeric" });
}

export function whenLabel(at: number): string {
  const date = new Date(at);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay ? niceTime(at) : date.toLocaleDateString(calendarLocale(), { month: "short", day: "numeric" });
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return t("ui.scheduleLabel.countMin", { count: minutes });
  if (minutes % 60 === 0) return t("ui.scheduleLabel.countHr", { count: minutes / 60 });
  return t("ui.scheduleLabel.hoursHrMinutesMin", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

export function intervalLabel(minutes: number): string {
  if (minutes < 60) return t("ui.scheduleLabel.everyCountMin", { count: minutes });
  if (minutes === 60) return t("automations.when.everyHour");
  if (minutes % 60 === 0) return t("ui.scheduleLabel.everyCountHr", { count: minutes / 60 });
  return t("ui.scheduleLabel.everyHoursHrMinutesMin", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

function intervalRestrictions(schedule: Extract<RoutineSchedule, { type: "interval" }>): string[] {
  const details: string[] = [];
  if (schedule.weekdays && schedule.weekdays.length < 7) {
    details.push(schedule.weekdays.join(",") === "1,2,3,4,5"
      ? t("ui.scheduleLabel.weekdays")
      : schedule.weekdays.map((day) => dayNames()[day]).join(", "));
  }
  if (schedule.window) {
    const wallTime = (time: string) => {
      const [hour, minute] = time.split(":").map(Number);
      return niceTime(new Date(2000, 0, 1, hour, minute).getTime());
    };
    details.push(`${wallTime(schedule.window.start)}–${wallTime(schedule.window.end)}`);
  }
  if (schedule.endsAt != null) {
    details.push(t("ui.scheduleLabel.untilDate", { date: new Date(schedule.endsAt).toLocaleDateString(calendarLocale(), { month: "short", day: "numeric", year: "numeric" }) }));
  }
  return details;
}

export function scheduleLabel(schedule: RoutineSchedule | { type: "once"; at: number } | { type: "daily"; time: string; weekdays: number[] }): string {
  if (schedule.type === "cron") return cronScheduleLabel(schedule, { locale: activeLocale(), format: t });
  if (schedule.type === "limit_reset") return limitResetWhen(schedule);
  if (schedule.type === "once") return t("ui.scheduleLabel.dateTime", { date: niceDate(schedule.at), time: niceTime(schedule.at) });
  if (schedule.type === "interval") {
    return [intervalLabel(schedule.everyMinutes), ...intervalRestrictions(schedule)].join(" · ");
  }
  const days = schedule.weekdays;
  const label = days.length === 7
    ? t("computer.routine.everyDay")
    : days.join(",") === "1,2,3,4,5"
      ? t("ui.scheduleLabel.everyWeekday")
      : days.length === 1
        ? t("ui.scheduleLabel.weeklyOnDay", { day: dayNames()[days[0]!]! })
        : days.map((day) => dayNames()[day]).join(", ");
  return t("ui.scheduleLabel.daysAtTime", { days: label, time: niceTime(atLocalTime(Date.now(), schedule.time)) });
}

export function scheduleSentence(schedule: RoutineSchedule): string {
  if (schedule.type === "cron") return cronScheduleLabel(schedule, { locale: activeLocale(), format: t });
  if (schedule.type === "limit_reset") return limitResetWhen(schedule).toLocaleLowerCase();
  if (schedule.type === "interval") {
    const minutes = schedule.everyMinutes;
    const cadence = minutes < 60 ? t("ui.scheduleLabel.everyCountMinutes", { count: minutes })
      : minutes === 60 ? t("ui.scheduleLabel.everyHour")
        : minutes % 60 === 0 ? t("ui.scheduleLabel.everyCountHours", { count: minutes / 60 })
          : t(Math.floor(minutes / 60) === 1 ? "ui.scheduleLabel.everyHoursHourMinutesMinutes" : "ui.scheduleLabel.everyHoursHoursMinutesMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
    return [cadence, ...intervalRestrictions(schedule)].join(" · ");
  }
  if (schedule.type === "once") {
    return t("ui.scheduleLabel.onceOnDateTime", { date: niceDate(schedule.at), time: niceTime(schedule.at) });
  }
  const days = schedule.weekdays;
  const timeStr = niceTime(atLocalTime(Date.now(), schedule.time));

  if (days.length === 7) {
    return t("ui.scheduleLabel.everyDayAtTime", { time: timeStr });
  }
  if (days.join(",") === "1,2,3,4,5") {
    return t("ui.scheduleLabel.everyWeekdayAtTime", { time: timeStr });
  }
  if (days.length === 1) {
    return t("ui.scheduleLabel.weeklyOnDayAtTime", { day: dayNames()[days[0]!]!, time: timeStr });
  }

  return t("ui.scheduleLabel.daysAtTime", { days: days.map((day) => dayNames()[day]).join(", "), time: timeStr });
}
