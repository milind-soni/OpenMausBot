import { describe, expect, it } from "vitest";

import type { McpChangeRequest, OptionCardData } from "../../shared/wire.ts";
import type { Store } from "../store.ts";
import { resumableCards } from "./resumable-cards.ts";

const request: McpChangeRequest = { requestId: "r1", botId: "kiwi", threadId: "t1", action: "enable", name: "linear" };
const card = (extra: Partial<OptionCardData> = {}, mcp: Partial<McpChangeRequest> = {}): OptionCardData => ({
  title: "Turn on linear?", subtitle: "https://mcp.linear.app/mcp", options: ["Turn on", "Cancel"], requestId: "r1", tool: "mcp_server",
  ...extra, mcpRequest: { ...request, ...mcp },
});
const waitsOn = (one: OptionCardData) =>
  resumableCards({ activePath: () => [{ id: "m1", at: 10, role: "bot", kind: "options", card: one }] } as unknown as Pick<Store, "activePath">, "t1", 0);

describe("resumableCards", () => {
  it("resumableCards waits on an open mcpRequest card", () => {
    expect(waitsOn(card())).toEqual([{ id: "m1", waits: "MCP server decision: Turn on linear?" }]);
    expect(waitsOn(card({ answered: "allow" }, { result: { state: "applied", text: "Turned on." } })), "answered, not yet handed to the turn").toHaveLength(1);
    expect(waitsOn(card({ answered: "allow" }, { result: { state: "applied", text: "Turned on." }, resumed: true }))).toEqual([]);
    expect(waitsOn(card({ answered: "unavailable", dismissed: true })), "closed by Stop").toEqual([]);
    expect(waitsOn(card({ expired: true, options: [] })), "superseded").toEqual([]);
  });
});
