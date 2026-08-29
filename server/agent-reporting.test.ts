import { describe, expect, it } from "vitest";

import { notifyRoutineCompletion, reportingSystemPrompt } from "./agent-reporting.ts";

describe("reportingSystemPrompt", () => {
  it("keeps the default behavior unchanged", () => {
    expect(reportingSystemPrompt(undefined)).toBe("");
    expect(reportingSystemPrompt("all")).toBe("");
  });

  it("makes quiet monitoring and direct-answer behavior explicit", () => {
    expect(reportingSystemPrompt("actionable")).toMatch(/successful checks/);
    expect(reportingSystemPrompt("actionable")).toMatch(/explicitly requested/);
    expect(reportingSystemPrompt("silent")).toMatch(/Reply normally/);
  });

  it("does not buzz for ordinary routine completion in quieter modes", () => {
    expect(notifyRoutineCompletion("all")).toBe(true);
    expect(notifyRoutineCompletion("actionable")).toBe(false);
    expect(notifyRoutineCompletion("silent")).toBe(false);
  });
});
