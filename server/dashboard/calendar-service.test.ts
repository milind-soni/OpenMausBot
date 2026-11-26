import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import { CALENDAR_LIST_TOOL, CALENDARS_TOOL } from "../connected-reads.ts";

const mocks = vi.hoisted(() => ({
  initCount: 0,
  toolCalls: [] as Array<{ slug: string; args: Record<string, unknown> }>,
  calendars: [{ id: "primary", summary: "Personal", primary: true, accessRole: "owner", backgroundColor: "#1a73e8" }],
}));

vi.mock("../composio.ts", () => ({
  configured: () => true,
  sharedConnectedInventory: async () => ({
    complete: true,
    services: { googlecalendar: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "acc-1", status: "ACTIVE" }] } },
  }),
  relayMcp: async (_cfg: AppConfig, payload: { method: string; id?: string; params?: { arguments?: { tools?: Array<{ tool_slug: string; arguments: Record<string, unknown> }> } } }) => {
    if (payload.method === "initialize") {
      mocks.initCount += 1;
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} })), contentType: "application/json", transportSessionId: "t-1" };
    }
    if (payload.method === "notifications/initialized") {
      return { status: 200, bytes: new Uint8Array(), contentType: "application/json" };
    }
    const tool = payload.params!.arguments!.tools![0]!;
    mocks.toolCalls.push({ slug: tool.tool_slug, args: tool.arguments });
    const data = tool.tool_slug === CALENDARS_TOOL
      ? { items: mocks.calendars }
      : { items: [{ id: "ev-1", summary: "Standup", start: { dateTime: "2026-11-26T09:00:00Z" }, end: { dateTime: "2026-11-26T09:30:00Z" } }] };
    const text = JSON.stringify({ successful: true, data });
    return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text }] } })), contentType: "application/json" };
  },
}));

import { CALENDAR_CHOICES_TTL_MS, createDashboardCalendarService } from "./calendar-service.ts";

describe("dashboard calendar service", () => {
  it("shares one MCP initialize handshake across calendar validation and event fetch, and caches calendarChoices for 60s", async () => {
    let clock = 1_000_000;
    const service = createDashboardCalendarService(() => ({}) as AppConfig, () => clock);

    mocks.initCount = 0;
    mocks.toolCalls = [];
    const first = await service.agenda(["primary"], Date.parse("2026-11-26T00:00:00Z"), Date.parse("2026-11-30T00:00:00Z"));
    expect(first).toMatchObject({ missing: false, calendars: [{ id: "primary", color: "#1a73e8" }] });
    expect(mocks.initCount).toBe(1);
    expect(mocks.toolCalls.map((call) => call.slug)).toEqual([CALENDARS_TOOL, CALENDAR_LIST_TOOL]);

    mocks.initCount = 0;
    mocks.toolCalls = [];
    clock += CALENDAR_CHOICES_TTL_MS - 1;
    await service.agenda(["primary"], Date.parse("2026-11-26T00:00:00Z"), Date.parse("2026-11-30T00:00:00Z"));
    expect(mocks.initCount).toBe(1);
    expect(mocks.toolCalls.map((call) => call.slug)).toEqual([CALENDAR_LIST_TOOL]);

    mocks.toolCalls = [];
    await service.calendars();
    expect(mocks.toolCalls).toEqual([]);

    clock += 2;
    await service.calendars();
    expect(mocks.toolCalls.map((call) => call.slug)).toEqual([CALENDARS_TOOL]);
  });
});
