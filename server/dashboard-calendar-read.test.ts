import { describe, expect, it } from "vitest";
import { CALENDAR_LIST_TOOL, CALENDARS_TOOL, createConnectedReads, type ConnectedReadDeps } from "./connected-reads.ts";

describe("selected dashboard calendar reads", () => {
  function fixture() {
    const calls: Array<{ account?: string; tool_slug: string; arguments: Record<string, unknown> }> = [];
    const relay: ConnectedReadDeps["relay"] = async (payload) => {
      const frame = payload as { method: string; id: string; params?: { arguments: { tools: typeof calls } } };
      if (frame.method !== "tools/call") return { status: 200, bytes: new Uint8Array(), transportSessionId: "fixture" };
      const tool = frame.params!.arguments.tools[0]!;
      calls.push(tool);
      if (tool.tool_slug === CALENDARS_TOOL) {
        const text = JSON.stringify({ successful: true, data: { items: [{ id: "school", summary: "School", primary: true, accessRole: "owner" }] } });
        return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text }] } })) };
      }
      if (tool.account !== "selected-account" || tool.arguments.calendarId !== "school") throw new Error("Unselected source queried");
      const data = {
        items: [{ id: tool.arguments.pageToken ? "second" : "first", summary: "Class", start: { date: "2026-11-25" }, end: { date: "2026-11-26" } }],
        ...(tool.arguments.pageToken ? {} : { nextPageToken: "next" }),
      };
      const text = JSON.stringify({ successful: true, data });
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text }] } })) };
    };
    const session = createConnectedReads({ relay, connected: async () => ({ googlecalendar: true }), accounts: async () => ({ googlecalendar: "selected-account" }) }).session();
    return { session, calls };
  }
  const request = { account: "selected-account", calendarIds: ["school"], fromMs: Date.parse("2026-11-25"), toMs: Date.parse("2026-11-26") };

  it("pins the approved account on every page without showDeleted, while preserving showDeleted for general events()", async () => {
    const { session, calls } = fixture();
    expect((await session.selectedCalendarEvents(request)).map((event) => event.id)).toEqual(["first", "second"]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.account === "selected-account" && call.tool_slug === CALENDAR_LIST_TOOL && call.arguments.calendarId === "school" && !("showDeleted" in call.arguments))).toBe(true);

    calls.length = 0;
    await session.events(request.fromMs, request.toMs);
    expect(calls.find((call) => call.tool_slug === CALENDAR_LIST_TOOL)?.arguments.showDeleted).toBe(true);
  });

  it("makes no provider calls for an empty selection and rejects blank accounts upfront", async () => {
    const { session, calls } = fixture();
    expect(await session.selectedCalendarEvents({ ...request, calendarIds: [] })).toEqual([]);
    await expect(session.selectedCalendarEvents({ ...request, account: "" })).rejects.toThrow("account");
    expect(calls).toEqual([]);
  });

  it("uses the relay's authorized default account when the inventory omits account IDs", async () => {
    let tool: Record<string, unknown> | undefined;
    const relay: ConnectedReadDeps["relay"] = async (payload) => {
      const frame = payload as { method: string; id: string; params?: { arguments: { tools: Record<string, unknown>[] } } };
      if (frame.method !== "tools/call") return { status: 200, bytes: new Uint8Array(), transportSessionId: "fixture" };
      tool = frame.params!.arguments.tools[0];
      const text = JSON.stringify({ successful: true, data: { items: [] } });
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text }] } })) };
    };
    const session = createConnectedReads({ relay, connected: async () => ({ googlecalendar: true }) }).session();
    await session.selectedCalendarEvents({ calendarIds: ["primary"], fromMs: request.fromMs, toMs: request.toMs });
    expect(tool).toMatchObject({ tool_slug: CALENDAR_LIST_TOOL, arguments: { calendarId: "primary" } });
    expect(tool).not.toHaveProperty("account");
  });

  it("lists selectable calendars with validated hex colors only", async () => {
    const calls: Array<{ account?: string; tool_slug: string }> = [];
    const relay: ConnectedReadDeps["relay"] = async (payload) => {
      const frame = payload as { method: string; id: string; params?: { arguments: { tools: Array<{ account?: string; tool_slug: string }> } } };
      if (frame.method !== "tools/call") return { status: 200, bytes: new Uint8Array(), transportSessionId: "fixture" };
      const tool = frame.params!.arguments.tools[0]!;
      calls.push(tool);
      const text = JSON.stringify({ successful: true, data: { items: [
        { id: "primary", summary: "Me", primary: true, accessRole: "owner", backgroundColor: "#1a73e8" },
        { id: "team", summary: "Team", accessRole: "reader", selected: false, backgroundColor: "url(javascript:1)" },
        { id: "shared-writer", summary: "Shared", accessRole: "writerWithoutPrivateAccess", selected: false },
        { id: "freebusy", summary: "Busy", accessRole: "freeBusyReader" },
        { id: "hidden", summary: "Hidden", accessRole: "owner", hidden: true },
      ] } });
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text }] } })) };
    };
    const session = createConnectedReads({ relay, connected: async () => ({ googlecalendar: true }) }).session();
    await expect(session.calendarChoices("selected-account")).resolves.toEqual([
      { id: "primary", name: "Me", primary: true, color: "#1a73e8" },
      { id: "team", name: "Team", primary: false },
      { id: "shared-writer", name: "Shared", primary: false },
    ]);
    expect(calls).toEqual([{ account: "selected-account", tool_slug: CALENDARS_TOOL, arguments: {} }]);
  });

  it("reduces shared-calendar event pages when the relay shortens large answers", async () => {
    const pageSizes: number[] = [];
    const relay: ConnectedReadDeps["relay"] = async (payload) => {
      const frame = payload as { method: string; id: string; params?: { arguments: { tools: Array<{ tool_slug: string; arguments: Record<string, unknown> }> } } };
      if (frame.method !== "tools/call") return { status: 200, bytes: new Uint8Array(), transportSessionId: "fixture" };
      const tool = frame.params!.arguments.tools[0]!;
      pageSizes.push(Number(tool.arguments.maxResults));
      const data = Number(tool.arguments.maxResults) > 10
        ? { results: [{ tool_slug: tool.tool_slug, response: { successful: true, data_preview: "large response" } }] }
        : { items: [{ id: "shared-event", summary: "Shared event", start: { dateTime: "2026-11-25T10:00:00Z" }, end: { dateTime: "2026-11-25T11:00:00Z" } }] };
      const text = JSON.stringify({ successful: true, data });
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text }] } })) };
    };
    const session = createConnectedReads({ relay, connected: async () => ({ googlecalendar: true }) }).session();
    const events = await session.selectedCalendarEvents({ account: "selected-account", calendarIds: ["shared@example.test"], fromMs: request.fromMs, toMs: request.toMs });
    expect(events.map((one) => one.id)).toEqual(["shared-event"]);
    expect(pageSizes).toEqual([100, 50, 25, 12, 6]);
  });
});
