// scheduleSentence() used to build its output by rewriting the short label
// with English regexes ("Every 5 min" → "every 5 minutes"), and the run card
// kept rendered labels in a module-scope map. Both are the kind of thing that
// keeps working in English and quietly stops working everywhere else.
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import { locales } from "@/locales";
import { dayFull, dayNarrow, durationLabel, intervalLabel, scheduleLabel, scheduleSentence } from "./schedule-label";

afterEach(() => {
  setLocale("en");
});

/** A pack that does not carry a key yet falls back to English, which is what
 * the reader sees — assert against that rather than skipping the pack. */
function packValue(pack: Partial<Record<string, string>>, key: string): string {
  return pack[key] ?? locales.en![key as keyof typeof locales.en]!;
}

describe("schedule labels in other languages", () => {
  it("writes an interval sentence from keys, not from the short label", () => {
    setLocale("pt-br");
    const pack = locales["pt-br"]!;

    expect(scheduleSentence({ type: "interval", everyMinutes: 5, anchorAt: 0 })).toBe(
      pack["schedule.sentence.every"]!.replace(
        "{span}",
        pack["schedule.sentence.minutes"]!.replace("{count}", "5"),
      ),
    );
    // 60 minutes is its own phrase in every language, not "every 1 hour".
    expect(scheduleSentence({ type: "interval", everyMinutes: 60, anchorAt: 0 })).toBe(
      pack["schedule.sentence.everyHour"],
    );
    // The singular hour must not pick up the plural key.
    expect(scheduleSentence({ type: "interval", everyMinutes: 90, anchorAt: 0 })).toContain(
      pack["schedule.sentence.hourOne"],
    );
    expect(scheduleSentence({ type: "interval", everyMinutes: 120, anchorAt: 0 })).toContain(
      pack["schedule.sentence.hourMany"]!.replace("{count}", "2"),
    );
    expect(scheduleSentence({ type: "interval", everyMinutes: 5, anchorAt: 0 })).not.toMatch(/minutes/);
  });

  it("translates durations and cadences in every pack", () => {
    for (const [code, pack] of Object.entries(locales)) {
      setLocale(code);
      expect(durationLabel(30), code).toBe(packValue(pack, "schedule.durationMin").replace("{count}", "30"));
      expect(intervalLabel(60), code).toBe(packValue(pack, "schedule.everyHour"));
    }
  });

  // Slicing the first character off a translated day name is what broke here:
  // every Chinese weekday starts with 周, so seven day chips read alike.
  it("gives every weekday a distinct narrow chip and a full name", () => {
    const days = [0, 1, 2, 3, 4, 5, 6];
    for (const code of Object.keys(locales)) {
      setLocale(code);
      const narrow = days.map(dayNarrow);
      const full = days.map(dayFull);
      expect(new Set(full).size, `${code} full names`).toBe(7);
      expect(narrow.every((label) => label.length > 0), code).toBe(true);
    }

    setLocale("zh");
    expect(new Set(days.map(dayNarrow)).size, "zh narrow chips").toBe(7);
    expect(days.map(dayNarrow)).toEqual(["日", "一", "二", "三", "四", "五", "六"]);
    expect(dayFull(3)).toBe("星期三");

    setLocale("zh-tw");
    expect(new Set(days.map(dayNarrow)).size, "zh-tw narrow chips").toBe(7);
  });

  it("names the weekday through the catalog in a weekly schedule", () => {
    setLocale("de");
    const label = scheduleLabel({ type: "daily", time: "09:00", weekdays: [3] });
    expect(label).toContain(locales.de!["computer.day.wed"]);
    expect(label).not.toContain("Weekly on");
  });
});
