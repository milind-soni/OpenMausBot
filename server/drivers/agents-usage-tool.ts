import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const USAGE_LIMITS_TOOL = "usage_limits";

export async function callUsageLimitsTool(context: Pick<ToolCallContext, "client">, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  const { scope, period, thread } = args;
  if (scope !== undefined && scope !== "subscription" && scope !== "bot") return { text: "scope must be subscription or bot.", isError: true };
  if (scope !== "bot" && (period !== undefined || thread !== undefined)) return { text: "period and thread require scope: bot.", isError: true };
  if (period !== undefined && period !== "today" && period !== "month") return { text: "period must be today or month.", isError: true };
  if (thread !== undefined && thread !== "this") return { text: "thread must be this or omitted.", isError: true };

  const path = "/api/internal/engine-limits";
  const query = new URLSearchParams({ scope: "bot", ...(period ? { period } : {}), ...(thread ? { thread } : {}) });
  const { ok, body } = await context.client.apiResponse(scope === "bot" ? `${path}?${query}` : path);
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "Usage limits could not be read. Try again shortly."), isError: true };
}

export const USAGE_LIMITS_TOOL_DEFINITION = {
  name: USAGE_LIMITS_TOOL,
  description: "AI subscription limits and reset times by default. With scope bot, read this bot's visible tokens, estimated cost and usage cap headroom. Bot periods use UTC.",
  inputSchema: { type: "object", additionalProperties: false, properties: {
    scope: { type: "string", enum: ["subscription", "bot"], default: "subscription" },
    period: { type: "string", enum: ["today", "month"], description: "Bot scope only. Defaults to today." },
    thread: { type: "string", enum: ["this"], description: "Bot scope only. Omit for all visible conversations." },
  } },
};
