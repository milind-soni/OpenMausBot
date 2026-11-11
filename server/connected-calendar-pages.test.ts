import { describe, expect, it } from "vitest";

import { CALENDAR_LIST_TOOL, CALENDARS_TOOL, createConnectedReads, type ConnectedReadDeps } from "./connected-reads.ts";

const event = (id: string) => ({ id, start: { dateTime: "2026-11-11T10:00:00Z" }, end: { dateTime: "2026-11-11T11:00:00Z" } });
const primary = { id: "primary", primary: true, accessRole: "owner" };

function fixture(answer: (slug: string, args: Record<string, unknown>) => unknown | Promise<unknown>) {
  const calls: Array<{ slug: string; args: Record<string, unknown>; signal: AbortSignal }> = [];
  const relay: ConnectedReadDeps["relay"] = async (payload, _session, signal) => {
    const frame = payload as { method: string; id: string; params?: { arguments: { tools: Array<{ tool_slug: string; arguments: Record<string, unknown> }> } } };
    if (frame.method !== "tools/call") return { status: 200, bytes: new Uint8Array(), transportSessionId: "session" };
    const item = frame.params!.arguments.tools[0]!;
    calls.push({ slug: item.tool_slug, args: item.arguments, signal });
    const data = await answer(item.tool_slug, item.arguments);
    const text = JSON.stringify({ successful: true, data: { results: [{ tool_slug: item.tool_slug, response: { successful: true, data } }] } });
    return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text }] } })) };
  };
  const session = createConnectedReads({ connected: async () => ({ gmail: false, googlecalendar: true }), relay }).session();
  return { calls, read: () => session.events(Date.parse("2026-11-11T00:00:00Z"), Date.parse("2026-11-12T00:00:00Z")) };
}

describe("complete calendar reads", () => {
  it("reads later calendar and event pages with each tool's parameter spelling", async () => {
    const { read, calls } = fixture((slug, args) => {
      if (slug === CALENDARS_TOOL) return args.page_token
        ? { items: [{ id: "team", selected: true, accessRole: "reader" }] }
        : { items: [primary], nextPageToken: "more-calendars" };
      if (args.calendarId === "team") return { items: [event("team-event")] };
      return args.pageToken ? { items: [event("later-event")] } : { items: [event("first-event")], nextPageToken: "more-events" };
    });
    const events = await read();
    expect(events.map((one) => one.id)).toEqual(["first-event", "later-event", "team-event"]);
    expect(events.map((one) => one.calendarId)).toEqual(["primary", "primary", "team"]);
    expect(calls.filter((one) => one.slug === CALENDARS_TOOL).map((one) => one.args.page_token)).toEqual([undefined, "more-calendars"]);
    const pages = calls.filter((one) => one.slug === CALENDAR_LIST_TOOL && one.args.calendarId === "primary");
    expect(pages[1]!.args).toEqual({ ...pages[0]!.args, pageToken: "more-events" });
    expect(new Set(calls.map((one) => one.signal)).size).toBe(1);
  });

  it("continues through an empty page with a token inside response_data", async () => {
    const { read } = fixture((slug, args) => slug === CALENDARS_TOOL ? { items: [primary] } : args.pageToken
      ? { response_data: { items: [event("after-empty")] } }
      : { response_data: { items: [], nextPageToken: "next" } });
    expect((await read()).map((one) => one.id)).toEqual(["after-empty"]);
  });

  it.each([CALENDARS_TOOL, CALENDAR_LIST_TOOL])("refuses repeated page tokens from %s instead of returning partial availability", async (looping) => {
    const { read, calls } = fixture((slug) => {
      if (slug === looping) return { items: slug === CALENDARS_TOOL ? [primary] : [event("partial")], nextPageToken: "repeated" };
      return { items: [primary] };
    });
    await expect(read()).rejects.toMatchObject({ app: "googlecalendar", message: expect.stringMatching(/repeated.*page token/) });
    expect(calls.filter((one) => one.slug === looping)).toHaveLength(2);
  });

  it("bounds a server that returns an endless sequence of new page tokens", async () => {
    let page = 0;
    const { read } = fixture((slug) => slug === CALENDARS_TOOL ? { items: [primary] }
      : { items: [event(`event-${page}`)], nextPageToken: String(++page) });
    await expect(read()).rejects.toMatchObject({ app: "googlecalendar", message: expect.stringMatching(/too many pages/) });
    expect(page).toBe(20);
  });

  it("reports a failed continuation instead of treating the first page as complete", async () => {
    const { read } = fixture((slug, args) => {
      if (slug === CALENDARS_TOOL) return { items: [primary] };
      if (args.pageToken) throw new Error("continuation unavailable");
      return { items: [event("partial")], nextPageToken: "next" };
    });
    await expect(read()).rejects.toMatchObject({ app: "googlecalendar", message: expect.stringContaining("continuation unavailable") });
  });
});
