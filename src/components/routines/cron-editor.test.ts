import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CronScheduleFields, CronSchedulePreview } from "./CronScheduleFields";
import { cronChoiceFor, cronDraftFor, cronEditorValue } from "./cron-editor";
import type { RoutineCronSchedule } from "../../../shared/routine-schedule";

const after = Date.parse("2026-01-10T12:00:00Z");
const schedule: RoutineCronSchedule = { type: "cron", expression: "0 9 L * *", timeZone: "America/New_York" };

describe("cron routine editor", () => {
  it("opens monthly and yearly presets in their saved zone, not the viewer's", () => {
    expect(cronChoiceFor(schedule)).toBe("monthly");
    expect(cronDraftFor(schedule, after)).toMatchObject({ day: "L", time: "09:00", timeZone: "America/New_York" });
    const yearly = { ...schedule, expression: "30 18 15 12 *" };
    expect(cronChoiceFor(yearly)).toBe("yearly");
    expect(cronDraftFor(yearly, after)).toMatchObject({ day: "15", month: "12", time: "18:30" });
  });

  it("keeps an arbitrary expression exactly on an unrelated title or prompt edit", () => {
    const custom = { ...schedule, expression: "15 9-17/2 * * 1-5" };
    expect(cronChoiceFor(custom)).toBe("cron");
    const result = cronEditorValue("cron", cronDraftFor(custom, after), after, custom);
    expect(result.error).toBe("");
    expect(result.schedule).toBe(custom);
    expect(result.runs).toHaveLength(3);
    const spaced = { ...schedule, expression: "00 09   L * *" };
    expect(cronEditorValue("monthly", cronDraftFor(spaced, after), after, spaced).schedule).toBe(spaced);
  });

  it("calculates three monthly last-day previews and a yearly leap-day preset", () => {
    const draft = cronDraftFor(schedule, after);
    expect(cronEditorValue("monthly", draft, after).runs.map(at => new Date(at).toISOString())).toEqual([
      "2026-01-31T14:00:00.000Z", "2026-02-28T14:00:00.000Z", "2026-03-31T13:00:00.000Z",
    ]);
    const leap = cronEditorValue("yearly", { ...draft, month: "2", day: "29", timeZone: "UTC" }, after);
    expect(leap.schedule).toEqual({ type: "cron", expression: "0 9 29 2 *", timeZone: "UTC" });
    expect(new Date(leap.runs[0]).getUTCFullYear()).toBe(2028);
  });

  it("reports invalid expressions, impossible dates, empty times and invalid zones inline", () => {
    const draft = cronDraftFor(schedule, after);
    for (const patch of [{ expression: "not cron" }, { expression: "0 9 31 2 *" }, { timeZone: "Not/AZone" }]) {
      const result = cronEditorValue("cron", { ...draft, ...patch }, after);
      expect(result.schedule).toBeNull();
      expect(result.runs).toEqual([]);
      expect(result.error).not.toBe("");
    }
    expect(cronEditorValue("monthly", { ...draft, time: "" }, after).error).toContain("Choose a time");
    const markup = renderToStaticMarkup(createElement(CronScheduleFields, { choice: "cron", value: draft, onChange: vi.fn(), runs: [], error: "Invalid cron expression" }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).not.toContain("Next runs");
  });

  it("shows compact native fields and previews without crashing on zone whitespace", () => {
    const draft = { ...cronDraftFor(schedule, after), timeZone: " UTC " };
    const result = cronEditorValue("monthly", draft, after);
    const markup = renderToStaticMarkup(createElement(CronScheduleFields, { choice: "monthly", value: draft, onChange: vi.fn(), runs: result.runs, error: result.error }));
    expect(markup).toContain("Last day");
    expect(markup).toContain("Time zone");
    expect(markup).toContain("Next runs · UTC");
    expect(markup.match(/<time /g)).toHaveLength(3);
    expect(markup).not.toContain("Cron expression");
  });

  it("labels paused dates as a preview, not scheduled runs", () => {
    const markup = renderToStaticMarkup(createElement(CronSchedulePreview, { schedule, paused: true }));
    expect(markup).toContain("Paused — schedule preview");
    expect(markup).not.toContain("Next runs");
    expect(markup).not.toContain("Next scheduled runs");
    expect(markup.match(/<time /g)).toHaveLength(3);
  });
});
