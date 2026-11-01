import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { CronScheduleFields } from "./CronScheduleFields";
import { cronDraftFor } from "./cron-editor";

afterEach(() => setLocale("en"));

describe("Chinese calendar fields", () => {
  it.each(["zh", "zh-tw"])("renders labels and month names in %s while preserving schedule values", (code) => {
    setLocale(code);
    const value = cronDraftFor({ type: "cron", expression: "0 9 L 1 *", timeZone: "America/New_York" }, Date.parse("2026-01-01T00:00:00Z"));
    const html = renderToStaticMarkup(createElement(CronScheduleFields, {
      choice: "yearly", value, onChange: vi.fn(), runs: [], error: "",
    }));
    expect(html).toContain(code === "zh" ? "时区" : "時區");
    expect(html).toContain("月末");
    expect(html).not.toContain("January");
    expect(html).not.toContain("Time zone");
    expect(html).toContain('value="America/New_York"');
    expect(html).toContain('value="L"');
  });
});
