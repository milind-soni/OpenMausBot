import { describe, expect, it } from "vitest";

import { plainWhen } from "./plain-time.ts";

describe("plainWhen", () => {
  const now = Date.parse("2026-10-27T13:43:00Z");

  it("says today, tomorrow or the day, in that zone's calendar", () => {
    expect(plainWhen(Date.parse("2026-10-27T16:30:00Z"), "Asia/Kolkata", now)).toBe("today at 10:00 PM");
    expect(plainWhen(Date.parse("2026-10-28T03:30:00Z"), "Asia/Kolkata", now)).toBe("tomorrow (Wednesday, October 28) at 9:00 AM");
    expect(plainWhen(Date.parse("2026-10-30T03:30:00Z"), "Asia/Kolkata", now)).toBe("Friday, October 30 at 9:00 AM");
    // 21:00 in Los Angeles on the 27th is the 28th in India
    expect(plainWhen(Date.parse("2026-10-28T04:00:00Z"), "America/Los_Angeles", now)).toBe("today at 9:00 PM");
  });
});
