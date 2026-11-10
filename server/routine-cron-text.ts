import { cronPreset, type CronPreset } from "../shared/cron-label.ts";
import { plainTimeZone } from "../shared/plain-time-zone.ts";
import type { RoutineCronSchedule } from "../shared/routine-schedule.ts";
import { byLanguage } from "./language.ts";
import { serverLine, type ServerLineKey } from "./server-lines.ts";

type Nth = Extract<CronPreset, { kind: "monthlyNth" }>["nth"];
const NTH: Record<Nth, ServerLineKey> = {
  1: "server.routines.cron.nth.first", 2: "server.routines.cron.nth.second", 3: "server.routines.cron.nth.third",
  4: "server.routines.cron.nth.fourth", 5: "server.routines.cron.nth.fifth", last: "server.routines.cron.nth.last",
};
const NTH_WEEKEND: Record<Nth, ServerLineKey> = {
  1: "server.routines.cron.nthWeekend.first", 2: "server.routines.cron.nthWeekend.second", 3: "server.routines.cron.nthWeekend.third",
  4: "server.routines.cron.nthWeekend.fourth", 5: "server.routines.cron.nthWeekend.fifth", last: "server.routines.cron.nthWeekend.last",
};

function presetText(preset: CronPreset, language: string | undefined): string {
  const locale = byLanguage({ en: "en-US", de: "de-DE", "pt-br": "pt-BR" }, language);
  const time = locale === "en-US" ? preset.time.replace(/^0(?=\d:)/, "") : preset.time;
  const weekdayName = (day: number) => new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2023, 0, 1 + day));
  const monthName = (month: number) => new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(Date.UTC(2023, month, 1));
  switch (preset.kind) {
    case "everyDay": return serverLine(language, "server.routines.cron.everyDay", { time });
    case "monthlyLastDay": return serverLine(language, "server.routines.cron.monthlyLastDay", { time });
    case "monthlyDay": return serverLine(language, "server.routines.cron.monthlyDay", { day: preset.day, time });
    case "yearly": return serverLine(language, "server.routines.cron.yearly", { month: monthName(preset.month), day: preset.day, time });
    case "weekdays": return serverLine(language, "server.routines.cron.weekdays", { time });
    case "weekly": return serverLine(language, preset.weekday === 0 || preset.weekday === 6 ? "server.routines.cron.weeklySaturdaySunday" : "server.routines.cron.weekly", { weekday: weekdayName(preset.weekday), time });
    case "monthlyNth": return serverLine(language, (preset.weekday === 0 || preset.weekday === 6 ? NTH_WEEKEND : NTH)[preset.nth], { weekday: weekdayName(preset.weekday), time });
  }
}

export function routineCronText(schedule: RoutineCronSchedule, language?: string): string {
  const preset = cronPreset(schedule.expression);
  const text = preset ? presetText(preset, language) : serverLine(language, "server.routines.cron.raw", { expression: schedule.expression });
  return `${text} ${plainTimeZone(schedule.timeZone)}`;
}

export function formatInstant(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString();
  }
}

