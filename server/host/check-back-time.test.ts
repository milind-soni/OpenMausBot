import { describe, expect, it } from "vitest";

import { parseWhen, wallClockLabel, zonedInstant } from "./check-back-time.ts";

// Thursday 19 November 2026, 14:00 UTC (15:00 in Berlin, 09:00 in New York, 19:30 in Kolkata).
const NOW = Date.UTC(2026, 10, 19, 14, 0);
const at = (when: string, zone = "UTC", now = NOW) => {
  const result = parseWhen(when, now, zone);
  if (!result.ok) throw new Error(result.error);
  return new Date(result.at).toISOString();
};

describe("parseWhen", () => {
  it("reads spans from now", () => {
    expect(at("in 5 minutes")).toBe("2026-11-19T14:05:00.000Z");
    expect(at("in 2 hours")).toBe("2026-11-19T16:00:00.000Z");
    expect(at("in an hour")).toBe("2026-11-19T15:00:00.000Z");
    expect(at("in half an hour")).toBe("2026-11-19T14:30:00.000Z");
    expect(at("in 1h30m")).toBe("2026-11-19T15:30:00.000Z");
    expect(at("in 2 hours and 15 minutes")).toBe("2026-11-19T16:15:00.000Z");
    expect(at("3 days from now")).toBe("2026-11-22T14:00:00.000Z");
    expect(at("in 1 week")).toBe("2026-11-26T14:00:00.000Z");
  });

  it("takes an exact time with its own offset, whatever the zone", () => {
    expect(at("2026-11-21T09:00:00+01:00", "Asia/Kolkata")).toBe("2026-11-21T08:00:00.000Z");
    expect(at("2026-11-21T09:00Z", "America/New_York")).toBe("2026-11-21T09:00:00.000Z");
    expect(at("2026-11-21T09:00:00+0530")).toBe("2026-11-21T03:30:00.000Z");
  });

  it("reads a time without an offset in the person's zone", () => {
    expect(at("2026-11-21T09:00", "Europe/Berlin")).toBe("2026-11-21T08:00:00.000Z");
    expect(at("2026-11-21 09:00", "Asia/Kolkata")).toBe("2026-11-21T03:30:00.000Z");
  });

  it("reads days and times in the person's zone", () => {
    expect(at("Friday 9am", "America/New_York")).toBe("2026-11-20T14:00:00.000Z");
    expect(at("9am friday", "America/New_York")).toBe("2026-11-20T14:00:00.000Z");
    expect(at("tomorrow at 4 pm", "Europe/Berlin")).toBe("2026-11-20T15:00:00.000Z");
    expect(at("tomorrow 16:00", "Asia/Kolkata")).toBe("2026-11-20T10:30:00.000Z");
    expect(at("monday", "Europe/Berlin")).toBe("2026-11-23T08:00:00.000Z");
    expect(at("next thursday", "UTC")).toBe("2026-11-26T09:00:00.000Z");
    expect(at("tonight", "Europe/Berlin")).toBe("2026-11-19T19:00:00.000Z");
    expect(at("2026-12-01", "UTC")).toBe("2026-12-01T09:00:00.000Z");
  });

  it("moves a time already passed today to tomorrow, and today's weekday to next week once its time passed", () => {
    expect(at("4pm", "Europe/Berlin")).toBe("2026-11-19T15:00:00.000Z");
    expect(at("2pm", "Europe/Berlin")).toBe("2026-11-20T13:00:00.000Z");
    expect(at("thursday 10:00", "America/New_York")).toBe("2026-11-19T15:00:00.000Z");
    expect(at("thursday 8:00", "America/New_York")).toBe("2026-11-26T13:00:00.000Z");
  });

  it("moves a skipped wall-clock time forward through the gap and takes the first of a repeated one", () => {
    expect(new Date(zonedInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York")).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(new Date(zonedInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/New_York")).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(new Date(zonedInstant({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, "Europe/Berlin")).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(new Date(zonedInstant({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, "Europe/Berlin")).toISOString()).toBe("2026-10-25T00:30:00.000Z");
    const beforeSpring = Date.UTC(2026, 2, 7, 15, 0);
    expect(at("tomorrow 9am", "America/New_York", beforeSpring)).toBe("2026-03-08T13:00:00.000Z");
  });

  it("lands on the whole minute whatever second it is now", () => {
    expect(at("Friday 9am", "Asia/Kolkata", NOW + 55_086)).toBe("2026-11-20T03:30:00.000Z");
    expect(at("4pm", "Europe/Berlin", NOW + 12_345)).toBe("2026-11-19T15:00:00.000Z");
  });

  it("refuses what it can't read, with the forms it can", () => {
    for (const when of ["", "soon", "in a while", "whenever", "25:00", "friday 13pm", "2026-13-40T99:00"]) {
      const result = parseWhen(when, NOW, "UTC");
      expect(result.ok, when).toBe(false);
      if (!result.ok) expect(result.error).toContain("in 2 hours");
    }
  });
});

describe("wallClockLabel", () => {
  it("names the day and the time in the zone", () => {
    expect(wallClockLabel(Date.UTC(2026, 10, 20, 14, 0), "America/New_York")).toBe("Fri 20 Nov 09:00");
  });
});
