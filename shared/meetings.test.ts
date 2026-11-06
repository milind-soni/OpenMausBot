import { describe, expect, it } from "vitest";
import { consentLine, findMeetingLink, parseMeetingLink, ZOOM_NOT_SUPPORTED } from "./meetings.ts";

describe("meeting links", () => {
  it("knows Google Meet, Microsoft Teams and Jitsi links", () => {
    expect(parseMeetingLink("https://meet.google.com/abc-defg-hij")).toMatchObject({ ok: true, platform: "meet" });
    expect(parseMeetingLink("https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d")).toMatchObject({ ok: true, platform: "teams" });
    expect(parseMeetingLink("https://teams.live.com/meet/9381234567890?p=abcdef")).toMatchObject({ ok: true, platform: "teams" });
    expect(parseMeetingLink("https://meet.systemli.org/weeklysync")).toMatchObject({ ok: true, platform: "jitsi" });
    expect(parseMeetingLink("https://meet.jit.si/OurStandup")).toMatchObject({ ok: true, platform: "jitsi" });
  });

  it("answers a Zoom link plainly and refuses anything else", () => {
    expect(parseMeetingLink("https://us02web.zoom.us/j/123456789?pwd=x")).toEqual({ ok: false, error: ZOOM_NOT_SUPPORTED });
    for (const link of ["http://meet.google.com/abc-defg-hij", "https://meet.google.com/", "https://evil.example/abc-defg-hij", "https://user:pw@meet.jit.si/x", "not a link"]) {
      expect(parseMeetingLink(link).ok).toBe(false);
    }
  });

  it("finds a Teams link in a calendar description", () => {
    const description = "Join the meeting now <https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x>. Meeting ID: 1";
    expect(findMeetingLink(description)).toBe("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x");
    expect(findMeetingLink("lunch at noon")).toBeNull();
  });

  it("names the bot and the person it takes notes for", () => {
    expect(consentLine("Ada", "Milind")).toBe("Hi, I'm Ada (notes) from MausBot, taking notes for Milind. Ask me with @notes. Type \"@notes stop\" and I'll leave.");
    expect(consentLine("Ada", undefined)).toContain("taking notes for the person who invited me");
  });
});
