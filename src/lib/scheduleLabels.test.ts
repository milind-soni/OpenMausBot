import { describe, expect, it } from "vitest";
import { relativeTime } from "./scheduleLabels";

describe("relativeTime", () => {
  const now = Date.parse("2026-11-19T09:00:00Z");
  it("describes upcoming runs in plain units", () => {
    expect(relativeTime("2026-11-19T09:20:00Z", now)).toBe("in 20 min");
    expect(relativeTime("2026-11-19T14:00:00Z", now)).toBe("in 5 h");
    expect(relativeTime("2026-11-23T09:00:00Z", now)).toBe("in 4 days");
  });
  it("marks past or invalid times safely", () => {
    expect(relativeTime("2026-11-19T08:00:00Z", now)).toBe("due now");
    expect(relativeTime("not a date", now)).toBe("");
  });
});
