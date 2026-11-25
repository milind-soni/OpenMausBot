import { cronPreset, cronScheduleLabel, type CronPreset } from "../../shared/cron-label";
import type { RoutineCronSchedule } from "../../shared/routine-schedule";
import { activeLocale, t } from "@/lib/i18n";
import { namesLocale } from "@/lib/clock-time";
import type { LocaleKey } from "@/locales";

type Nth = Extract<CronPreset, { kind: "monthlyNth" }>["nth"];

const NTH: Record<Nth, LocaleKey> = {
  1: "routines.cron.nth.first", 2: "routines.cron.nth.second", 3: "routines.cron.nth.third",
  4: "routines.cron.nth.fourth", 5: "routines.cron.nth.fifth", last: "routines.cron.nth.last",
};
const NTH_SATURDAY_SUNDAY: Record<Nth, LocaleKey> = {
  1: "routines.cron.nthWeekend.first", 2: "routines.cron.nthWeekend.second", 3: "routines.cron.nthWeekend.third",
  4: "routines.cron.nthWeekend.fourth", 5: "routines.cron.nthWeekend.fifth", last: "routines.cron.nthWeekend.last",
};

const saturdayOrSunday = (weekday: number) => weekday === 0 || weekday === 6;

export const weekdayName = (day: number): string =>
  new Intl.DateTimeFormat(namesLocale(), { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2023, 0, 1 + day));
const monthName = (month: number): string =>
  new Intl.DateTimeFormat(namesLocale(), { month: "long", timeZone: "UTC" }).format(Date.UTC(2023, month, 1));

function presetText(preset: CronPreset): string {
  const time = activeLocale() === "en" ? preset.time.replace(/^0(?=\d:)/, "") : preset.time;
  switch (preset.kind) {
    case "everyDay": return t("routines.cron.everyDay", { time });
    case "monthlyLastDay": return t("routines.cron.monthlyLastDay", { time });
    case "monthlyDay": return t("routines.cron.monthlyDay", { day: preset.day, time });
    case "yearly": return t("routines.cron.yearly", { month: monthName(preset.month), day: preset.day, time });
    case "weekdays": return t("routines.cron.weekdays", { time });
    case "weekly": return t(saturdayOrSunday(preset.weekday) ? "routines.cron.weeklySaturdaySunday" : "routines.cron.weekly", { weekday: weekdayName(preset.weekday), time });
    case "monthlyNth": {
      const keys = saturdayOrSunday(preset.weekday) ? NTH_SATURDAY_SUNDAY : NTH;
      return t(keys[preset.nth], { weekday: weekdayName(preset.weekday), time });
    }
  }
}

export function cronPresetText(schedule: Pick<RoutineCronSchedule, "expression">): string | null {
  const preset = cronPreset(schedule.expression);
  return preset ? presetText(preset) : null;
}

export function cronText(schedule: RoutineCronSchedule): string {
  if (activeLocale() === "en") return cronScheduleLabel(schedule);
  return `${cronPresetText(schedule) ?? t("routines.cron.raw", { expression: schedule.expression })} · ${schedule.timeZone}`;
}
