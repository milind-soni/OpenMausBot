import { describe, expect, it } from "vitest";

import { cronScheduleLabel } from "../shared/cron-label.ts";
import { routineCronText } from "./routine-cron-text.ts";
import "./server-line-packs.ts";

const expressions = [
  "0 9 * * *", "30 18 L * *", "5 0 14 * *", "15 8 25 12 *", "0 9 * * 1-5", "0 9 * * MON-FRI", "*/5 * * * *",
  ...Array.from({ length: 8 }, (_, day) => `0 9 * * ${day}`),
  ...[1, 2, 3, 4, 5, "L"].flatMap((nth) => Array.from({ length: 8 }, (_, day) => `0 9 * * ${day}#${nth}`)),
];

describe("cron words on a routine request", () => {
  it.each(expressions)("preserves the English label for %s", (expression) => {
    const schedule = { type: "cron" as const, expression, timeZone: "America/New_York" };
    expect(routineCronText(schedule)).toBe(cronScheduleLabel(schedule));
    expect(routineCronText(schedule, "en")).toBe(cronScheduleLabel(schedule));
    expect(routineCronText(schedule, "en-GB")).toBe(cronScheduleLabel(schedule));
  });

  it.each([
    ["0 9 * * *", "Todo dia às 09:00"],
    ["0 9 L * *", "Todo mês no último dia às 09:00"],
    ["0 9 14 * *", "Todo mês no dia 14 às 09:00"],
    ["0 9 25 12 *", "Todo ano em 25 de dezembro às 09:00"],
    ["0 9 * * 1-5", "De segunda a sexta às 09:00"],
    ["0 9 * * 1", "Toda segunda-feira às 09:00"],
    ["0 9 * * 0", "Todo domingo às 09:00"],
    ["0 9 * * 1#2", "Todo mês na segunda segunda-feira às 09:00"],
    ["0 9 * * 6#L", "Todo mês no último sábado às 09:00"],
    ["*/5 * * * *", "Cron */5 * * * *"],
  ])("localizes %s without changing its expression or time zone", (expression, text) => {
    const schedule = { type: "cron" as const, expression, timeZone: "UTC" };
    expect(routineCronText(schedule, "pt-br")).toBe(`${text} UTC`);
    expect(schedule.expression).toBe(expression);
  });

  it.each(["0 9 * * 1-5", "0 9 * * MON-FRI"])("names Monday through Friday explicitly in German for %s", (expression) => {
    const schedule = { type: "cron" as const, expression, timeZone: "UTC" };
    expect(routineCronText(schedule, "de")).toBe("Montag bis Freitag um 09:00 UTC");
  });

  it("has German words and falls back to complete English for an untranslated language", () => {
    const schedule = { type: "cron" as const, expression: "0 9 * * 1", timeZone: "UTC" };
    expect(routineCronText(schedule, "de")).toBe("Jede Woche am Montag um 09:00 UTC");
    expect(routineCronText(schedule, "fr")).toBe("Weekly on Monday at 9:00 UTC");
  });

  it("uses Traditional Chinese weekday names for zh-TW", () => {
    const schedule = { type: "cron" as const, expression: "0 9 * * 1", timeZone: "UTC" };
    expect(routineCronText(schedule, "zh-tw")).toContain("星期一");
    const yearly = routineCronText({ type: "cron" as const, expression: "0 9 1 3 *", timeZone: "UTC" }, "zh-tw");
    expect(yearly).toContain("3月");
    expect(yearly).not.toContain("March");
  });
});
