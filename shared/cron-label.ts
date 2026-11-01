import { plainTimeZone } from "./plain-time-zone.ts";
import type { RoutineCronSchedule } from "./routine-schedule.ts";

const COPY = {
  custom: "server.localeCoverage.cronCustom",
  daily: "server.localeCoverage.cronDaily",
  monthlyLast: "server.localeCoverage.cronMonthlyLast",
  monthlyDay: "server.localeCoverage.cronMonthlyDay",
  yearly: "server.localeCoverage.cronYearly",
  weekdays: "server.localeCoverage.cronWeekdays",
  weekly: "server.localeCoverage.cronWeekly",
  first: "server.localeCoverage.cronMonthlyFirst",
  second: "server.localeCoverage.cronMonthlySecond",
  third: "server.localeCoverage.cronMonthlyThird",
  fourth: "server.localeCoverage.cronMonthlyFourth",
  fifth: "server.localeCoverage.cronMonthlyFifth",
  last: "server.localeCoverage.cronMonthlyLastWeekday",
} as const;

export type CronLabelKey = typeof COPY[keyof typeof COPY];
export interface CronLabelWords {
  locale: string;
  format: (key: CronLabelKey, params?: Record<string, string | number>) => string;
}

/** Describe familiar presets; retain the exact expression for everything else.
 * This is presentation only, never a second parser or source of scheduling truth. */
export function cronScheduleLabel(schedule: RoutineCronSchedule, words?: CronLabelWords): string {
  const locale = words?.locale ?? "en";
  const phrase = (key: CronLabelKey, params: Record<string, string | number>, english: string) => words?.format(key, params) ?? english;
  const weekdayName = (day: number) => new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + day)));
  const monthName = (month: number) => new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, month - 1, 1)));
  const [minute, hour, day, month, weekday] = schedule.expression.trim().split(/\s+/);
  let label = phrase(COPY.custom, { expression: schedule.expression }, `Cron ${schedule.expression}`);
  if (/^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "")) {
    const time = `${Number(hour)}:${minute!.padStart(2, "0")}`;
    const monthDay = /^\d+$/.test(day ?? "") ? Number(day) : null;
    if (weekday === "*" && month === "*") {
      if (day === "*") label = phrase(COPY.daily, { time }, `Every day at ${time}`);
      else if (day === "L") label = phrase(COPY.monthlyLast, { time }, `Monthly on the last day at ${time}`);
      else if (monthDay !== null) label = phrase(COPY.monthlyDay, { day: monthDay, time }, `Monthly on day ${monthDay} at ${time}`);
    } else if (weekday === "*" && /^\d+$/.test(month ?? "") && monthDay !== null) {
      const number = Number(month);
      if (number >= 1 && number <= 12) {
        const name = monthName(number);
        label = phrase(COPY.yearly, { month: name, day: monthDay, time }, `Yearly on ${name} ${monthDay} at ${time}`);
      }
    } else if (day === "*" && month === "*") {
      if (weekday === "1-5" || weekday?.toUpperCase() === "MON-FRI") label = phrase(COPY.weekdays, { time }, `Every weekday at ${time}`);
      else if (/^[0-7]$/.test(weekday ?? "")) {
        const name = weekdayName(Number(weekday) % 7);
        label = phrase(COPY.weekly, { weekday: name, time }, `Weekly on ${name} at ${time}`);
      }
      else {
        const nth = /^([0-7])#([1-5]|L)$/i.exec(weekday ?? "");
        if (nth) {
          const order = nth[2]!.toUpperCase() === "L" ? "last" : ["", "first", "second", "third", "fourth", "fifth"][Number(nth[2])];
          const name = weekdayName(Number(nth[1]) % 7);
          label = phrase(COPY[order as "first" | "second" | "third" | "fourth" | "fifth" | "last"], { weekday: name, time }, `Monthly on the ${order} ${name} at ${time}`);
        }
      }
    }
  }
  return `${label} ${plainTimeZone(schedule.timeZone, locale)}`;
}
