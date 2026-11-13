import { describe, expect, it } from "vitest";

import { eventsFromData } from "./connected-reads.ts";
import { clashes, planMeetings } from "./host/check-plan.ts";
import { busyTimes } from "./host/person-calendar.ts";

const now = Date.parse("2026-11-11T08:00:00Z");
const raw = (id: string, start: string, end: string, transparency?: string) => ({
  id, summary: id, start: { dateTime: `2026-11-11T${start}:00Z` }, end: { dateTime: `2026-11-11T${end}:00Z` },
  attendees: [{ email: "colleague@example.test" }], ...(transparency === undefined ? {} : { transparency }),
});
const read = (items: unknown[]) => eventsFromData({ items }, { id: "primary", owned: true });

describe("calendar events marked Available", () => {
  it("does not fill or merge a member's free time with a transparent event", () => {
    const events = read([
      raw("first", "09:00", "10:00"), raw("available", "09:30", "11:30", "transparent"),
      raw("last", "11:00", "12:00", "opaque"),
    ]);
    expect(busyTimes(events)).toEqual([
      { start: Date.parse("2026-11-11T09:00:00Z"), end: Date.parse("2026-11-11T10:00:00Z") },
      { start: Date.parse("2026-11-11T11:00:00Z"), end: Date.parse("2026-11-11T12:00:00Z") },
    ]);
  });

  it("does not report a clash with a transparent event, while retaining real clashes", () => {
    const events = read([
      raw("first", "09:00", "10:00"), raw("available", "09:15", "11:00", "transparent"),
      raw("second", "09:30", "10:30", "opaque"),
    ]);
    expect(clashes(events, { now, timeZone: "UTC" }).map((pair) => pair.map((event) => event.id)))
      .toEqual([["first", "second"]]);
  });

  it("keeps Available meetings readable and eligible for their usual preparation", () => {
    const events = read([raw("available", "09:00", "10:00", "transparent")]);
    expect(events).toHaveLength(1);
    expect(planMeetings({ now, events, meetings: {}, checkMs: 60_000 })).toEqual([
      { kind: "prep", event: events[0], short: true },
    ]);
  });

  it("defaults omitted and unrecognized transparency values to busy", () => {
    for (const transparency of [undefined, "opaque", "unexpected"]) {
      expect(busyTimes(read([raw("busy", "09:00", "10:00", transparency)]))).toHaveLength(1);
    }
  });
});
