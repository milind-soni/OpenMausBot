import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceError, type CalendarEvent } from "./connected-reads.ts";
import { toAgenda } from "./dashboard/agenda.ts";
import { berlinDay, berlinMidnight } from "./dashboard/calendar-time.ts";
import { openCalendarPreferencesStore } from "./dashboard/calendar-preferences.ts";
import { createDashboardCalendarRoute } from "./routes/dashboard-calendar.ts";
import type { RouteContext } from "./routes/table.ts";

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "event-1", title: "Event", start: Date.parse("2026-11-25T10:00:00Z"), end: Date.parse("2026-11-25T11:00:00Z"),
  allDay: false, status: "confirmed", selfDeclined: false, attendees: [], location: "private location", description: "private notes", ...overrides,
});

describe("dashboard calendar agenda", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("groups events by Berlin date across midnight and DST boundaries, retains empty today, and respects exclusive all-day ends", () => {
    const days = toAgenda([{ calendarId: "primary", metadata: { backgroundColor: "#112233" }, events: [
      event({ id: "cancelled", status: "cancelled" }),
      event({ id: "ends-midnight", start: Date.parse("2026-11-25T22:00:00Z"), end: Date.parse("2026-11-25T23:00:00Z") }),
      event({ id: "berlin-late", start: Date.parse("2026-11-25T23:30:00Z"), end: Date.parse("2026-11-26T00:30:00Z") }),
      event({ id: "all-day", allDay: true, start: Date.parse("2026-11-25T00:00:00Z"), end: Date.parse("2026-11-27T00:00:00Z") }),
    ] }], "2026-11-25");

    expect(days.map(({ date }) => date)).toEqual(["2026-11-25", "2026-11-26"]);
    expect(days[0]!.events.map(({ id }) => id)).toEqual(["primary:all-day", "primary:ends-midnight"]);
    expect(days[1]!.events.map(({ id }) => id)).toEqual(["primary:all-day", "primary:berlin-late"]);
    expect(days[0]!.events[0]).toEqual({
      id: "primary:all-day", calendarId: "primary", title: "Event", start: "2026-11-25", end: "2026-11-27", allDay: true, color: "#112233",
    });
    expect(toAgenda([{ calendarId: "primary", events: [] }], "2026-11-25")).toEqual([{ date: "2026-11-25", events: [] }]);

    const dstDays = toAgenda([{ calendarId: "school", events: [
      event({ id: "dst", start: Date.parse("2026-03-28T23:00:00Z"), end: Date.parse("2026-03-30T22:00:00Z") }),
    ] }], "2026-03-29");
    expect(dstDays.map((day) => day.date)).toEqual(["2026-03-29", "2026-03-30"]);
    expect(Date.parse(berlinMidnight("2026-03-30")) - Date.parse(berlinMidnight("2026-03-29"))).toBe(23 * 3_600_000);
    expect(berlinDay(new Date("2026-03-29T22:00:00Z"))).toBe("2026-03-30");
  });

  it("returns display fields with calendar colors over a four-day Berlin range without leaking private fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T12:00:00Z"));
    const read = vi.fn(async (_calendarIds: readonly string[], _from: number, _to: number) => [{ calendarId: "primary", events: [event()] }]);
    const prefs = openCalendarPreferencesStore();
    prefs.save("local-owner", "account-1", ["primary", "team"]);
    let response: unknown;
    const handler = createDashboardCalendarRoute({ calendars: async () => ({
      accountId: "account-1", calendars: [
        { id: "primary", name: "Me", primary: true, color: "#0b8043" }, { id: "team", name: "Team", primary: false },
      ],
    }), events: read, preferences: prefs });
    await handler({
      path: "/api/dashboard/calendar-agenda", url: new URL("http://localhost/api/dashboard/calendar-agenda?calendarId=primary&calendarId=team"), method: "GET", res: { setHeader: vi.fn() },
      auth: { kind: "loopback", scopes: ["admin", "client"] },
      json: ((_res: unknown, status: number, body: unknown) => { response = { status, body }; }) as RouteContext["json"],
    } as unknown as RouteContext);

    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]![0]).toEqual(["primary", "team"]);
    expect(read.mock.calls[0]![1]).toBe(Date.parse("2026-11-24T23:00:00Z"));
    expect(read.mock.calls[0]![2] - read.mock.calls[0]![1]).toBe(4 * 24 * 60 * 60 * 1000);
    expect(JSON.stringify(response)).not.toContain("private location");
    expect(JSON.stringify(response)).not.toContain("private notes");
    expect(response).toMatchObject({ status: 200, body: [{ date: "2026-11-25", events: [{ title: "Event", color: "#0b8043" }] }] });
  });

  it("returns the calendar list and prunes unavailable selections when no calendar query is passed", async () => {
    const calendars = vi.fn(async () => ({ accountId: "account-1", calendars: [{ id: "primary", name: "me@example.test", primary: true }] }));
    const events = vi.fn(async (_calendarIds: readonly string[], _from: number, _to: number) => []);
    const prefs = openCalendarPreferencesStore();
    prefs.save("local-owner", "account-1", ["primary", "removed"]);
    let response: unknown;
    await createDashboardCalendarRoute({ calendars, events, preferences: prefs })({
      path: "/api/dashboard/calendar-agenda", url: new URL("http://localhost/api/dashboard/calendar-agenda"), method: "GET", res: { setHeader: vi.fn() },
      auth: { kind: "loopback", scopes: ["admin", "client"] },
      json: ((_res: unknown, status: number, body: unknown) => { response = { status, body }; }) as RouteContext["json"],
    } as unknown as RouteContext);
    expect(calendars).toHaveBeenCalledOnce();
    expect(events).not.toHaveBeenCalled();
    expect(response).toEqual({
      status: 200,
      body: { calendars: [{ id: "primary", name: "me@example.test", primary: true }], selectedCalendarIds: ["primary"] },
    });
    expect(prefs.selected("local-owner", "account-1")).toEqual(["primary"]);
  });

  it("classifies 403 provider errors accurately even on named accounts without leaking calendar identifiers", async () => {
    const handler = createDashboardCalendarRoute({
      calendars: async () => ({ accountId: "account-1", calendars: [{ id: "primary", name: "Me", primary: true }] }),
      events: async () => { throw new SourceError("googlecalendar", "403 access denied for private-calendar@example.test", true); },
      preferences: openCalendarPreferencesStore(),
    });
    let response: unknown;
    await handler({
      path: "/api/dashboard/calendar-agenda", url: new URL("http://localhost/api/dashboard/calendar-agenda?calendarId=primary"), method: "GET", res: { setHeader: vi.fn() },
      auth: { kind: "loopback", scopes: ["admin", "client"] },
      json: ((_res: unknown, status: number, body: unknown) => { response = { status, body }; }) as RouteContext["json"],
    } as unknown as RouteContext);
    expect(response).toMatchObject({ status: 503, body: { error: "Calendar events could not be read", stage: "events", code: "calendar_access_denied" } });
    expect(JSON.stringify(response)).not.toContain("private-calendar@example.test");
  });

  it("saves selections per authenticated user across sessions and isolates other users", async () => {
    const prefs = openCalendarPreferencesStore();
    const handler = createDashboardCalendarRoute({
      calendars: async () => ({ accountId: "account-1", calendars: [
        { id: "primary", name: "Me", primary: true }, { id: "family", name: "Family", primary: false },
      ] }),
      events: async () => [],
      preferences: prefs,
    });
    let response: unknown;
    await handler({
      path: "/api/dashboard/calendar-agenda", url: new URL("http://localhost/api/dashboard/calendar-agenda"), method: "PUT",
      req: {}, res: { setHeader: vi.fn() },
      auth: { kind: "session", session: { id: "session-1", userId: "portal:grant-1", email: "owner@example.test", membershipAuthority: "portal" } },
      readBody: async () => ({ calendarIds: ["family", "primary", "family"] }),
      json: ((_res: unknown, status: number, body: unknown) => { response = { status, body }; }) as RouteContext["json"],
    } as unknown as RouteContext);

    expect(response).toEqual({ status: 200, body: { selectedCalendarIds: ["family", "primary"] } });
    await handler({
      path: "/api/dashboard/calendar-agenda", url: new URL("http://localhost/api/dashboard/calendar-agenda"), method: "GET",
      res: { setHeader: vi.fn() },
      auth: { kind: "session", session: { id: "session-2", userId: "portal:grant-2", email: "owner@example.test", membershipAuthority: "portal" } },
      json: ((_res: unknown, status: number, body: unknown) => { response = { status, body }; }) as RouteContext["json"],
    } as unknown as RouteContext);
    expect(response).toMatchObject({ status: 200, body: { selectedCalendarIds: ["family", "primary"] } });

    await handler({
      path: "/api/dashboard/calendar-agenda", url: new URL("http://localhost/api/dashboard/calendar-agenda"), method: "GET",
      res: { setHeader: vi.fn() },
      auth: { kind: "session", session: { id: "session-3", userId: "portal:grant-3", email: "other@example.test", membershipAuthority: "portal" } },
      json: ((_res: unknown, status: number, body: unknown) => { response = { status, body }; }) as RouteContext["json"],
    } as unknown as RouteContext);
    expect(response).toMatchObject({ status: 200, body: { selectedCalendarIds: [] } });
  });
});
