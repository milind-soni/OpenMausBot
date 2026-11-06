import { plainTimeZone } from "./plain-time-zone.ts";
import type { RoutineCronSchedule } from "./routine-schedule.ts";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ORDERS = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", last: "last" } as const;

/** A familiar cron preset: `weekday` 0 (Sunday) to 6, `month` 0 (January) to 11, `time` "HH:MM". */
export type CronPreset =
  | { kind: "everyDay" | "monthlyLastDay" | "weekdays"; time: string }
  | { kind: "monthlyDay"; day: number; time: string }
  | { kind: "yearly"; month: number; day: number; time: string }
  | { kind: "weekly"; weekday: number; time: string }
  | { kind: "monthlyNth"; nth: keyof typeof ORDERS; weekday: number; time: string };

export function cronPreset(expression: string): CronPreset | null {
  const [minute, hour, day, month, weekday] = expression.trim().split(/\s+/);
  if (!/^\d+$/.test(minute ?? "") || !/^\d+$/.test(hour ?? "")) return null;
  const time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
  const monthDay = /^\d+$/.test(day ?? "") ? Number(day) : null;
  if (weekday === "*" && month === "*") {
    if (day === "*") return { kind: "everyDay", time };
    if (day === "L") return { kind: "monthlyLastDay", time };
    return monthDay === null ? null : { kind: "monthlyDay", day: monthDay, time };
  }
  if (weekday === "*" && /^\d+$/.test(month ?? "") && monthDay !== null) {
    return MONTHS[Number(month) - 1] ? { kind: "yearly", month: Number(month) - 1, day: monthDay, time } : null;
  }
  if (day !== "*" || month !== "*") return null;
  if (weekday === "1-5" || weekday?.toUpperCase() === "MON-FRI") return { kind: "weekdays", time };
  if (/^[0-7]$/.test(weekday ?? "")) return { kind: "weekly", weekday: Number(weekday) % 7, time };
  const nth = /^([0-7])#([1-5]|L)$/i.exec(weekday ?? "");
  if (!nth) return null;
  return { kind: "monthlyNth", nth: nth[2]!.toUpperCase() === "L" ? "last" : (Number(nth[2]) as 1 | 2 | 3 | 4 | 5), weekday: Number(nth[1]) % 7, time };
}

function englishPreset(preset: CronPreset): string {
  const time = preset.time.replace(/^0(?=\d:)/, "");
  switch (preset.kind) {
    case "everyDay": return `Every day at ${time}`;
    case "monthlyLastDay": return `Monthly on the last day at ${time}`;
    case "monthlyDay": return `Monthly on day ${preset.day} at ${time}`;
    case "yearly": return `Yearly on ${MONTHS[preset.month]} ${preset.day} at ${time}`;
    case "weekdays": return `Every weekday at ${time}`;
    case "weekly": return `Weekly on ${WEEKDAYS[preset.weekday]} at ${time}`;
    case "monthlyNth": return `Monthly on the ${ORDERS[preset.nth]} ${WEEKDAYS[preset.weekday]} at ${time}`;
  }
}

/** Describe familiar presets; retain the exact expression for everything else.
 * This is presentation only, never a second parser or source of scheduling truth. */
export function cronScheduleLabel(schedule: RoutineCronSchedule): string {
  const preset = cronPreset(schedule.expression);
  return `${preset ? englishPreset(preset) : `Cron ${schedule.expression}`} ${plainTimeZone(schedule.timeZone)}`;
}
