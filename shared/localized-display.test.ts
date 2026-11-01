import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t } from "../src/lib/i18n";
import { cronScheduleLabel } from "./cron-label.ts";
import { plainWeekdays } from "./plain-time-zone.ts";
import { soulDiffLines } from "./line-diff.ts";

afterEach(() => setLocale("en"));

describe("shared display copy", () => {
  it.each(["zh", "zh-tw"])("localizes cron descriptions in %s without changing the expression", (locale) => {
    setLocale(locale);
    const schedule = { type: "cron" as const, expression: "0 9 * * *", timeZone: "UTC" };
    expect(cronScheduleLabel(schedule, { locale, format: t })).toBe("每天 9:00 UTC");
    expect(schedule.expression).toBe("0 9 * * *");
    const yearly = cronScheduleLabel({ ...schedule, expression: "0 9 1 1 *" }, { locale, format: t });
    expect(yearly).not.toContain("January");
    const nth = cronScheduleLabel({ ...schedule, expression: "0 9 * * 1#2" }, { locale, format: t });
    expect(nth).toContain(locale === "zh" ? "第二个星期一" : "第二個星期一");
    expect(cronScheduleLabel({ ...schedule, expression: "15 9-17/2 * * 1-5" }, { locale, format: t })).toContain("15 9-17/2 * * 1-5");
  });

  it("localizes weekdays using the supplied words while retaining the English default", () => {
    expect(plainWeekdays([1, 2, 3, 4, 5], "zh-tw", { everyDay: "每天", weekdays: "平日" })).toBe("平日");
    expect(plainWeekdays([1, 3], "zh-CN")).not.toContain("Monday");
    expect(plainWeekdays([1, 3])).toBe("Monday, Wednesday");
  });

  it("localizes only generated diff headings, retaining instruction bytes and diff markers", () => {
    const before = "Never change API_KEY.";
    const after = "Keep API_KEY and https://example.test unchanged.";
    const lines = soulDiffLines(before, after, {
      heading: (oldBytes, newBytes) => `SOUL.md（${oldBytes} → ${newBytes} 字节）：`,
      largeChange: "完整替换：", empty: "（空）",
    });
    expect(lines[0]).toContain("字节");
    expect(lines.slice(1)).toEqual([`-${before}`, `+${after}`]);
    expect(soulDiffLines(before, after)[0]).toContain("bytes");
  });
});
