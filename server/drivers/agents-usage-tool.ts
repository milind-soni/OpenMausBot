import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const USAGE_LIMITS_TOOL = "usage_limits";

function optionalChoice(value: unknown): unknown {
  if (typeof value === "string") return value.trim().toLowerCase() || undefined;
  return value ?? undefined;
}

export async function callUsageLimitsTool(context: Pick<ToolCallContext, "client">, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  const scope = optionalChoice(args.scope);
  const period = optionalChoice(args.period);
  const thread = optionalChoice(args.thread);
  const error = (message: string): ToolCallResult => ({
    text: `${message} Try {} for subscription limits or {"scope":"bot","period":"today","thread":"this"} for bot usage.`, isError: true,
  });
  if (scope !== undefined && scope !== "subscription" && scope !== "bot") return error("scope must be subscription or bot.");
  if (scope !== "bot" && (period !== undefined || thread !== undefined)) return error("period and thread require scope: bot.");
  if (period !== undefined && period !== "today" && period !== "month") return error("period must be today or month.");
  if (thread !== undefined && thread !== "this") return error("thread must be this or omitted.");

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
