import { describe, expect, it } from "vitest";
import { isOccurrenceRun, isScheduledRun } from "./routine-occurrences.ts";

describe("isScheduledRun", () => {
  it("is true only for a run its schedule started, its checks included", () => {
    expect(isScheduledRun({ manual: false })).toBe(true);
    expect(isScheduledRun({ manual: false, triggerSource: "schedule" })).toBe(true);
    expect(isScheduledRun({ manual: true })).toBe(false);
    expect(isScheduledRun({ manual: false, triggerSource: "manual" })).toBe(false);
    expect(isScheduledRun({ manual: false, triggerSource: "webhook" })).toBe(false);
    expect(isScheduledRun({ manual: false, triggerSource: "startup" })).toBe(false);
  });

  it("keeps a check's run out of the schedule's occurrences", () => {
    expect(isOccurrenceRun({ manual: false, triggerSource: "schedule", checkKey: "k" })).toBe(false);
    expect(isScheduledRun({ manual: false, triggerSource: "schedule" })).toBe(true);
  });
});
