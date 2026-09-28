import { describe, expect, it, vi } from "vitest";

import { WATCHER_OPTIONS_CARD_BOT_ID } from "../../shared/options-card.ts";
import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools, type CatalogProfile } from "./agents-catalog.ts";

function profile(overrides: Partial<CatalogProfile> = {}): CatalogProfile {
  return {
    externalRuntime: false,
    coordinating: false,
    ownThreadCreation: false,
    skillAuthoring: false,
    sharedComputers: false,
    voiceNotes: false,
    botId: WATCHER_OPTIONS_CARD_BOT_ID,
    ...overrides,
  };
}

function context(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    botId: WATCHER_OPTIONS_CARD_BOT_ID,
    threadId: "thread-watcher",
    depth: 0,
    externalRuntime: false,
    coordinating: false,
    sharedComputers: false,
    client: {
      api: async () => ({}),
      apiResponse: async () => ({ ok: true, status: 200, body: {} }),
    },
    turn: {
      createdThisTurn: 0,
      roomPostsThisTurn: 0,
      threadsOpenedThisTurn: 0,
      memoryRefusalsThisTurn: 0,
      delegationTaskIdsThisTurn: new Set(),
    },
    ...overrides,
  };
}

describe("Watcher options-card tool", () => {
  it("is advertised only to Watcher interactive turns", () => {
    expect(availableTools(profile()).map((tool) => tool.name)).toContain("create_options_card");
    expect(availableTools(profile({ botId: "another-bot" })).map((tool) => tool.name)).not.toContain("create_options_card");
    expect(availableTools(profile({ externalRuntime: true })).map((tool) => tool.name)).not.toContain("create_options_card");
  });

  it("advertises the bounded two-through-six choice schema", () => {
    const tool = availableTools(profile()).find((candidate) => candidate.name === "create_options_card")!;
    const options = (tool.inputSchema.properties as any).options;
    expect(options).toMatchObject({ type: "array", minItems: 2, maxItems: 6, uniqueItems: true });
    expect(tool.inputSchema.required).toEqual(["title", "subtitle", "options"]);
  });

  it("refuses direct calls from another bot before a server round trip", async () => {
    const api = vi.fn(async () => ({}));
    const result = await callTool("create_options_card", {
      title: "Title", subtitle: "Subtitle", options: ["A", "B"],
    }, context({ botId: "another-bot", client: { api, apiResponse: async () => ({ ok: true, status: 200, body: {} }) } }));
    expect(result).toEqual({ text: "create_options_card is not enabled for this bot.", isError: true });
    expect(api).not.toHaveBeenCalled();
  });

  it("validates malformed calls before a server round trip", async () => {
    const api = vi.fn(async () => ({}));
    const result = await callTool("create_options_card", {
      title: "Title", subtitle: "Subtitle", options: ["Only one"],
    }, context({ client: { api, apiResponse: async () => ({ ok: true, status: 200, body: {} }) } }));
    expect(result).toEqual({ text: "options must contain 2-6 items.", isError: true });
    expect(api).not.toHaveBeenCalled();
  });

  it("posts normalized content to the current-thread route", async () => {
    const api = vi.fn(async () => ({ messageId: "message-1" }));
    const result = await callTool("create_options_card", {
      title: "  Possible match  ", subtitle: "  Choose one  ", options: ["  Ignore  ", "Draft"],
    }, context({ client: { api, apiResponse: async () => ({ ok: true, status: 200, body: {} }) } }));

    expect(api).toHaveBeenCalledWith("/api/internal/options-card", {
      method: "POST",
      body: JSON.stringify({ title: "Possible match", subtitle: "Choose one", options: ["Ignore", "Draft"] }),
    });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("message message-1");
    expect(result.text).toContain("authorizes no external action");
  });
});
