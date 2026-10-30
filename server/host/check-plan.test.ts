import { describe, expect, it } from "vitest";

import type { CalendarEvent, EmailHeader } from "../connected-reads.ts";
import {
  answered, clashes, EMAIL_MAX_AGE_MS, emailSince, FIRST_MAIL_LOOK_BACK_MS, fingerprint, mergeMeetings, nextMeetingDue, planMail, planMeetings, PREP_LEAD_MS, REMINDER_LEAD_MS, TRIAGE_BATCH,
} from "./check-plan.ts";

const MINUTE = 60_000;
const now = Date.parse("2026-10-22T08:00:00Z");
const meeting = (id: string, startsIn: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, title: id, start: now + startsIn, end: now + startsIn + 30 * MINUTE, allDay: false, status: "confirmed", selfDeclined: false,
  attendees: [{ email: "me@x.test", self: true, organizer: true }, { email: "ada@x.test", self: false, organizer: false }], ownedCalendar: true, ...extra,
});
const email = (id: string, agoMs: number): EmailHeader => ({ id, threadId: `t-${id}`, at: now - agoMs, from: "Ada <ada@x.test>", subject: id, preview: "" });

describe("meetings", () => {
  it("preps a meeting with others 4 hours ahead, short when the check came late, and reminds 10 minutes ahead", () => {
    const jobs = planMeetings({ now, checkMs: 15 * MINUTE, meetings: {}, events: [
      meeting("in-3h", 3 * 60 * MINUTE), meeting("in-5h", 5 * 60 * MINUTE), meeting("in-8m", 8 * MINUTE),
      meeting("solo", 60 * MINUTE, { attendees: [{ email: "me@x.test", self: true, organizer: true }] }),
      meeting("declined", 60 * MINUTE, { selfDeclined: true }), meeting("all-day", 60 * MINUTE, { allDay: true }),
    ] });
    expect(jobs.map((job) => [job.kind, job.event.id, job.kind === "prep" ? job.short : undefined])).toEqual([
      ["prep", "in-3h", true], ["prep", "in-8m", true], ["remind", "in-8m", undefined],
    ]);
  });

  it("does not prep twice, but preps again when the guest list or the time changed", () => {
    const event = meeting("m", 2 * 60 * MINUTE);
    const prepped = { m: { start: event.start, fingerprint: fingerprint(event), preppedAt: now - MINUTE } };
    expect(planMeetings({ now, checkMs: 15 * MINUTE, meetings: prepped, events: [event] })).toEqual([]);
    const moreGuests = { ...event, attendees: [...event.attendees, { email: "bo@x.test", self: false, organizer: false }] };
    expect(planMeetings({ now, checkMs: 15 * MINUTE, meetings: prepped, events: [moreGuests] }).map((job) => job.kind)).toEqual(["prep"]);
    expect(planMeetings({ now, checkMs: 15 * MINUTE, meetings: prepped, events: [{ ...event, start: event.start + MINUTE }] }).map((job) => job.kind)).toEqual(["prep"]);
  });

  it("names the next time a meeting needs prep or its reminder, the only time worth waking for", () => {
    const event = meeting("m", 6 * 60 * MINUTE);
    expect(nextMeetingDue({ now, events: [event], meetings: {} })).toBe(event.start - PREP_LEAD_MS);
    expect(nextMeetingDue({ now, events: [event], meetings: { m: { start: event.start, fingerprint: "", preppedAt: now } } })).toBe(event.start - REMINDER_LEAD_MS);
    expect(nextMeetingDue({ now, events: [meeting("solo", MINUTE * 300, { attendees: [] })], meetings: {} })).toBeUndefined();
  });

  it("shows a meeting several calendars carry once, and finds today's clashes", () => {
    const copy = (id: string, guests: number): CalendarEvent => meeting(id, 60 * MINUTE, { iCalUID: "uid-1", attendees: [
      { email: "me@x.test", self: false, organizer: true }, ...Array.from({ length: guests }, (_, index) => ({ email: `g${index}@x.test`, self: false, organizer: false })),
    ] });
    const merged = mergeMeetings([copy("a", 1), copy("b", 3)], "me@x.test");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.attendees).toHaveLength(4);
    expect(merged[0]!.attendees[0]!.self).toBe(true);
    const pairs = clashes([meeting("x", 60 * MINUTE), meeting("y", 70 * MINUTE), meeting("z", 3 * 60 * MINUTE)], { now, timeZone: "UTC" });
    expect(pairs.map(([first, second]) => [first.id, second.id])).toEqual([["x", "y"]]);
  });
});

describe("mail", () => {
  it("sends the newest batch to the AI, keeps day-old mail quiet, and leaves the rest waiting", () => {
    const emails = [...Array.from({ length: TRIAGE_BATCH + 3 }, (_, index) => email(`n${index}`, index * MINUTE)), email("old", EMAIL_MAX_AGE_MS + MINUTE), email("seen", MINUTE)];
    const plan = planMail({ now, emails, judged: new Set(["seen"]) });
    expect(plan.batch.map((one) => one.id)).toEqual(Array.from({ length: TRIAGE_BATCH }, (_, index) => `n${index}`));
    expect(plan.waiting.map((one) => one.id)).toEqual(["n20", "n21", "n22"]);
    expect(plan.quiet.map((one) => one.id)).toEqual(["old"]);
  });

  it("starts from the cursor but never more than a day back, and a first check reads the last 12 hours", () => {
    expect(emailSince({ now })).toBe(now - FIRST_MAIL_LOOK_BACK_MS);
    expect(emailSince({ now, emailCursor: now - MINUTE })).toBe(now - MINUTE);
    expect(emailSince({ now, emailCursor: 0 })).toBe(now - EMAIL_MAX_AGE_MS);
  });

  it("knows when the person already replied", () => {
    const sent = email("a", 60 * MINUTE);
    expect(answered(sent, [{ id: "r", at: now - MINUTE, from: "me@x.test" }], "me@x.test")).toBe(true);
    expect(answered(sent, [{ id: "r", at: now - MINUTE, from: "ada@x.test" }], "me@x.test")).toBe(false);
    expect(answered(sent, [{ id: "r", at: now - 2 * 60 * MINUTE, from: "me@x.test" }], "me@x.test")).toBe(false);
  });
});
