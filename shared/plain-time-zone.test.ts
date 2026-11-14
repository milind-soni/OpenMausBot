import { describe, expect, it } from "vitest";

import { plainClock, plainTimeZone, plainWeekdays } from "./plain-time-zone.ts";

describe("time zones in plain words", () => {
  it.each([
    ["Asia/Calcutta", "India time"],
    ["Asia/Kolkata", "India time"],
    ["America/Los_Angeles", "Pacific time"],
    ["America/New_York", "Eastern time"],
    ["America/Chicago", "Central time"],
    ["America/Denver", "Mountain time"],
    ["America/Phoenix", "Arizona time"],
    ["Europe/London", "UK time"],
    ["Europe/Berlin", "Germany time"],
    ["Asia/Tokyo", "Japan time"],
    ["Asia/Singapore", "Singapore time"],
    ["Asia/Dubai", "UAE time"],
    ["Australia/Sydney", "Sydney time"],
    ["UTC", "UTC"],
    ["Etc/UTC", "UTC"],
    ["Etc/GMT", "UTC"],
  ])("says %s as %s", (zone, said) => {
    expect(plainTimeZone(zone)).toBe(said);
  });

  it("never answers with an IANA id, an abbreviation or an offset", () => {
    for (const zone of Intl.supportedValuesOf("timeZone")) {
      const said = plainTimeZone(zone);
      if (said === "UTC") continue;
      expect(said, zone).not.toContain("/");
      expect(said, zone).not.toMatch(/^(?:[A-Z]{1,5}|GMT[+-].*)$/);
    }
    expect(plainTimeZone("Nowhere/Some_Place")).toBe("Some Place time");
  });

  it("names days the way people do", () => {
    expect(plainWeekdays([1, 2, 3, 4, 5])).toBe("weekdays");
    expect(plainWeekdays([0, 1, 2, 3, 4, 5, 6])).toBe("every day");
    expect(plainWeekdays([1, 3])).toBe("Monday, Wednesday");
  });

  it("writes a clock time without a leading zero", () => {
    expect(plainClock("09:00")).toBe("9:00");
    expect(plainClock("17:30")).toBe("17:30");
    expect(plainClock("00:15")).toBe("0:15");
  });
});
