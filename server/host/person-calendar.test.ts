import { describe, expect, it } from "vitest";

import type { CalendarEvent } from "../connected-reads.ts";
import { busyTimes, createPersonCalendar } from "./person-calendar.ts";

const H = 60 * 60_000;
const event = (start: number, end: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `e${start}`, title: "Salary review with HR", start, end, allDay: false, status: "confirmed", selfDeclined: false,
  attendees: [{ email: "hr@acme.test", self: false, organizer: true }], location: "Room 4", description: "Confidential", ...extra,
});

describe("busy times", () => {
  it("keeps only start and end, merges what touches, and leaves out declined, cancelled and day-long events", () => {
    const busy = busyTimes([
      event(10 * H, 11 * H), event(10.5 * H, 12 * H), event(12 * H, 13 * H), event(15 * H, 16 * H, { selfDeclined: true }),
      event(17 * H, 18 * H, { status: "cancelled" }), event(0, 24 * H, { allDay: true }), event(20 * H, 21 * H, { status: "tentative" }),
    ]);
    expect(busy).toEqual([{ start: 10 * H, end: 13 * H }, { start: 20 * H, end: 21 * H }]);
    expect(JSON.stringify(busy)).not.toMatch(/Salary|HR|Room|Confidential/);
  });
});

describe("a member's calendar", () => {
  const answer = (id: unknown, data: unknown, slug: string) => new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id,
    result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: [{ tool_slug: slug, response: { successful: true, data, error: null } }] }, error: null }) }] } }));
  const items = [{ id: "a", summary: "Salary review", status: "confirmed", start: { dateTime: "2026-10-29T14:00:00Z" }, end: { dateTime: "2026-10-29T15:00:00Z" },
    attendees: [{ email: "hr@acme.test" }], location: "Room 4" }];

  it("reads through the member's own access only, and answers busy times", async () => {
    const used: string[] = [];
    const calendar = createPersonCalendar({
      access: (person) => person === "p_marco" ? { url: "https://broker.test", token: "marco" } : null,
      connected: async (access) => access.token === "marco",
      relay: async (payload, _session, _signal, access) => {
        used.push(access.token);
        const frame = payload as { id?: unknown; method: string; params?: { arguments?: { tools?: Array<{ tool_slug: string }> } } };
        if (frame.method !== "tools/call") return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })), transportSessionId: "s" };
        const slug = frame.params!.arguments!.tools![0]!.tool_slug;
        return { status: 200, bytes: answer(frame.id, slug === "GOOGLECALENDAR_EVENTS_LIST" ? { items } : { items: [{ id: "primary", primary: true, accessRole: "owner" }] }, slug) };
      },
    });
    expect(await calendar.busy("p_marco", 0, Date.UTC(2026, 11, 1))).toEqual([{ start: Date.UTC(2026, 9, 29, 14), end: Date.UTC(2026, 9, 29, 15) }]);
    expect(new Set(used)).toEqual(new Set(["marco"]));
    expect(await calendar.busy("p_philipp", 0, Date.UTC(2026, 11, 1))).toBeNull();
  });
});
