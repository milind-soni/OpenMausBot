import { describe, expect, it } from "vitest";

import { routineCronText } from "./routine-cron-text.ts";
import "./server-line-packs.ts";

// The template comes from the pack, so a zh line may still read in English until that pack is complete. What this pins
// is the part the code chooses itself: the weekday, the month and the zone must be the ones a Chinese reader reads.
const weekly = { type: "cron" as const, expression: "0 9 * * 1", timeZone: "Asia/Shanghai" };
const monthly = { type: "cron" as const, expression: "0 9 1 3 *", timeZone: "Asia/Shanghai" };

describe("a routine line in Simplified Chinese", () => {
  it("names the weekday and the zone in Chinese", () => {
    const line = routineCronText(weekly, "zh");
    expect(line).toContain("星期一");
    expect(line).not.toContain("Monday");
    expect(line).not.toContain("China time");
    expect(line).toContain("中国时间");
  });

  it("names the month in Chinese", () => {
    const line = routineCronText(monthly, "zh");
    expect(line).toContain("3月");
    expect(line).not.toContain("March");
  });

  it("keeps English whole and leaves Traditional Chinese on its own locale", () => {
    expect(routineCronText(weekly, "en")).toBe("Weekly on Monday at 9:00 China time");
    expect(routineCronText(weekly, "zh-tw")).toContain("星期一");
    expect(routineCronText(weekly, "zh-tw")).not.toContain("Monday");
  });
});
