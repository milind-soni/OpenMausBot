// The per-turn clock line (server/turn-clock.ts): its exact shape across
// timezones, offsets and day boundaries, the turns it leaves alone, and that
// a later turn of the same conversation is stamped with its own time.
import { describe, expect, it } from "vitest";
import { hostTimeZone, takesTurnClock, turnClockLine, withTurnClock } from "./turn-clock.ts";

const at = (iso: string) => Date.parse(iso);

describe("turnClockLine", () => {
  it("names the weekday, local date and time, IANA timezone and UTC offset", () => {
    expect(turnClockLine(at("2026-10-08T16:48:00Z"), "Asia/Baghdad"))
      .toBe("Current time when this message was sent: Thursday, 2026-10-08 19:48 Asia/Baghdad (UTC+03:00).");
    expect(turnClockLine(at("2026-10-08T16:48:00Z"), "Asia/Kolkata"))
      .toBe("Current time when this message was sent: Thursday, 2026-10-08 22:18 Asia/Kolkata (UTC+05:30).");
    expect(turnClockLine(at("2026-10-08T16:48:00Z"), "UTC"))
      .toBe("Current time when this message was sent: Thursday, 2026-10-08 16:48 UTC (UTC+00:00).");
  });

  it("follows daylight saving and writes a western offset with an ASCII minus", () => {
    expect(turnClockLine(at("2026-01-15T17:05:00Z"), "America/New_York"))
      .toBe("Current time when this message was sent: Thursday, 2026-01-15 12:05 America/New_York (UTC-05:00).");
    expect(turnClockLine(at("2026-07-15T16:05:00Z"), "America/New_York"))
      .toBe("Current time when this message was sent: Wednesday, 2026-07-15 12:05 America/New_York (UTC-04:00).");
  });

  it("uses the local calendar day, not the UTC one, near midnight", () => {
    // 22:30 UTC on the 8th is already Friday the 9th in Baghdad
    expect(turnClockLine(at("2026-10-08T22:30:00Z"), "Asia/Baghdad")).toContain("Friday, 2026-10-09 01:30 Asia/Baghdad");
    // 03:00 UTC on the 9th is still Thursday the 8th in Los Angeles
    expect(turnClockLine(at("2026-10-09T03:00:00Z"), "America/Los_Angeles")).toContain("Thursday, 2026-10-08 20:00 America/Los_Angeles");
    // midnight reads 00:00, never 24:00
    expect(turnClockLine(at("2026-10-08T21:00:00Z"), "Asia/Baghdad")).toContain("Friday, 2026-10-09 00:00");
  });

  it("falls back to UTC for a timezone the runtime does not know, instead of failing the turn", () => {
    expect(turnClockLine(at("2026-10-08T16:48:00Z"), "Nowhere/Atlantis"))
      .toBe("Current time when this message was sent: Thursday, 2026-10-08 16:48 UTC (UTC+00:00).");
  });

  it("reads the host timezone the routine scheduler uses", () => {
    expect(hostTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });

  it("costs a few dozen tokens at most", () => {
    const longest = turnClockLine(at("2026-09-30T16:48:00Z"), "America/Argentina/ComodRivadavia");
    // the project's own estimate is bytes / 4 (previewSystemPrompt)
    expect(Math.ceil(Buffer.byteLength(longest) / 4)).toBeLessThanOrEqual(32);
  });
});

describe("withTurnClock", () => {
  const clock = turnClockLine(at("2026-10-08T16:48:00Z"), "Asia/Baghdad");

  it("puts the line in front of the turn, ahead of any recalled block", () => {
    expect(withTurnClock(clock, "what is on my calendar today?")).toBe(`${clock}\n\nwhat is on my calendar today?`);
    const recalled = "Recalled for this message …\n[end of recalled passages — the message follows]\n\nhi";
    expect(withTurnClock(clock, recalled).startsWith(`${clock}\n\nRecalled for this message`)).toBe(true);
  });

  it("leaves an image-only turn and an engine slash command untouched", () => {
    expect(withTurnClock(clock, "")).toBe("");
    expect(withTurnClock(clock, "  \n")).toBe("  \n");
    expect(withTurnClock(clock, "/compact")).toBe("/compact");
    expect(withTurnClock(clock, "  /review the diff")).toBe("  /review the diff");
  });

  it("decides on the person's own text, not on the context put in front of it", () => {
    expect(takesTurnClock("what day is it?")).toBe(true);
    expect(takesTurnClock("")).toBe(false);
    expect(takesTurnClock("/compact")).toBe(false);
    // dispatch passes an empty clock when the person's text skips it, so a
    // replayed transcript ahead of an image or a slash command stays as is
    const replayed = "Earlier in this conversation:\nuser: hi\n\n/compact";
    expect(withTurnClock(takesTurnClock("/compact") ? clock : "", replayed)).toBe(replayed);
    expect(withTurnClock(takesTurnClock("") ? clock : "", "Earlier in this conversation:\nuser: hi")).toBe("Earlier in this conversation:\nuser: hi");
  });

  it("stamps each turn of a long conversation with its own time", () => {
    // what the two dispatch sites in server/index.ts do: a fresh line per turn
    const first = withTurnClock(turnClockLine(at("2026-10-08T20:59:00Z"), "Asia/Baghdad"), "remind me tomorrow");
    const second = withTurnClock(turnClockLine(at("2026-10-08T21:01:00Z"), "Asia/Baghdad"), "and what day is it now?");
    expect(first).toContain("Thursday, 2026-10-08 23:59 Asia/Baghdad");
    expect(second).toContain("Friday, 2026-10-09 00:01 Asia/Baghdad");
    expect(second).not.toContain("2026-10-08");
  });
});
