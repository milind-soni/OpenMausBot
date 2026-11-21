import { describe, expect, it, vi } from "vitest";

import { isReadOnlyAgentTool } from "../agent-tool-policy.ts";
import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools } from "./agents-catalog.ts";
import { catalogProfileFromEnv } from "./agents-catalog-profile.ts";
import { callUsageLimitsTool, USAGE_LIMITS_TOOL } from "./agents-usage-tool.ts";

const context = (answer: { ok: boolean; body: Record<string, unknown> }) => ({ client: { apiResponse: vi.fn(async () => answer) } }) as unknown as ToolCallContext;

describe("the usage_limits tool", () => {
  it("is read-only and listed to every bot, Chief or not, in every conversation", () => {
    expect(isReadOnlyAgentTool(USAGE_LIMITS_TOOL)).toBe(true);
    for (const env of [{}, { OMB_CHIEF_OF_STAFF: "1" }, { OMB_ROOM_TURN: "1" }, { OMB_TEAM_PEOPLE: "1" }]) {
      const tools = availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "bot", ...env })).map((tool) => tool.name);
      expect(tools).toContain(USAGE_LIMITS_TOOL);
    }
  });

  it("reaches the route when a bot calls it by name", async () => {
    const asked = context({ ok: true, body: { text: '{"accounts":[]}' } });
    await expect(callTool(USAGE_LIMITS_TOOL, {}, asked)).resolves.toEqual({ text: '{"accounts":[]}' });
  });

  it("reads bot usage only when the caller selects it", async () => {
    const asked = context({ ok: true, body: { text: '{"totals":{"input":12}}' } });
    await expect(callTool(USAGE_LIMITS_TOOL, { scope: "bot", period: "month", thread: "this" }, asked))
      .resolves.toEqual({ text: '{"totals":{"input":12}}' });
    expect(asked.client.apiResponse).toHaveBeenCalledWith("/api/internal/engine-limits?scope=bot&period=month&thread=this");

    vi.mocked(asked.client.apiResponse).mockClear();
    await expect(callTool(USAGE_LIMITS_TOOL, { scope: "subscription", thread: "this" }, asked))
      .resolves.toMatchObject({ isError: true });
    expect(asked.client.apiResponse).not.toHaveBeenCalled();
  });

  it("hands the bot the route's answer, and its refusal as an error", async () => {
    const asked = context({ ok: true, body: { text: '{"accounts":[]}' } });
    await expect(callUsageLimitsTool(asked)).resolves.toEqual({ text: '{"accounts":[]}' });
    expect(asked.client.apiResponse).toHaveBeenCalledWith("/api/internal/engine-limits");
    await expect(callUsageLimitsTool(context({ ok: false, body: { error: "not yours" } }))).resolves.toEqual({ text: "not yours", isError: true });
  });
});
