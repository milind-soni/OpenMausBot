import { afterEach, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { durationLabel, intervalLabel, scheduleLabel } from "./schedule-label";

afterEach(() => setLocale("en"));

it.each([
  ["en", "Every 5 min", "1 hr 30 min"],
  ["zh", "每 5 分钟", "1 小时 30 分钟"],
  ["zh-tw", "每 5 分鐘", "1 小時 30 分鐘"],
])("uses %s for intervals and durations without changing schedule values", (locale, interval, duration) => {
  setLocale(locale);
  const schedule = { type: "interval" as const, everyMinutes: 5, anchorAt: 0 };
  expect(intervalLabel(5)).toBe(interval);
  expect(scheduleLabel(schedule)).toBe(interval);
  expect(durationLabel(90)).toBe(duration);
  expect(schedule).toEqual({ type: "interval", everyMinutes: 5, anchorAt: 0 });
});
