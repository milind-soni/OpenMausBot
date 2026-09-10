import { describe, expect, it } from "vitest";

import { activeLocale } from "./i18n";
import { intervalLabel, scheduleLabel, scheduleSentence, whenLabel } from "./schedule-label";

describe("schedule labels", () => {
  it("keeps interval restrictions in both compact labels and prose", () => {
    const schedule = { type: "interval" as const, everyMinutes: 5, anchorAt: 0,
      weekdays: [1, 2, 3, 4, 5], window: { start: "09:00", end: "17:00" },
      endsAt: new Date(2026, 8, 30, 23, 59).getTime() };
    for (const label of [scheduleLabel(schedule), scheduleSentence(schedule)]) {
      expect(label).toContain("weekdays");
      expect(label).toContain("until");
      expect(label).toContain("2026");
    }
  });
  it("names intervals", () => {
    expect(intervalLabel(5)).toBe("Every 5 min");
    expect(intervalLabel(60)).toBe("Every hour");
    expect(intervalLabel(120)).toBe("Every 2 hr");
    expect(intervalLabel(90)).toBe("Every 1 hr 30 min");
  });

  it("writes schedules as prose", () => {
    expect(scheduleSentence({ type: "interval", everyMinutes: 5, anchorAt: 0 })).toBe("every 5 minutes");
    expect(scheduleSentence({ type: "interval", everyMinutes: 60, anchorAt: 0 })).toBe("every hour");
    expect(scheduleSentence({ type: "interval", everyMinutes: 120, anchorAt: 0 })).toBe("every 2 hours");
    expect(scheduleSentence({ type: "interval", everyMinutes: 90, anchorAt: 0 })).toBe("every 1 hour 30 minutes");
    expect(scheduleSentence({ type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] })).toMatch(/^every weekday at /);
    expect(scheduleSentence({ type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] })).toMatch(/^every day at /);
    expect(scheduleSentence({ type: "daily", time: "09:00", weekdays: [3] })).toMatch(/^weekly on Wed at /);
    expect(scheduleSentence({ type: "once", at: Date.UTC(2026, 8, 5, 12) })).toMatch(/^once on /);
  });

  it("labels a change by time today and by date otherwise", () => {
    const now = Date.now();
    expect(whenLabel(now)).toBe(
      new Date(now).toLocaleTimeString(activeLocale(), { hour: "numeric", minute: "2-digit" }),
    );
    const lastYear = new Date(now);
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    expect(whenLabel(lastYear.getTime())).toBe(
      lastYear.toLocaleDateString(activeLocale(), { month: "short", day: "numeric" }),
    );
  });
});
