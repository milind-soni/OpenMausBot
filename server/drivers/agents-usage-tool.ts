// The agents catalog's usage_limits tool: one read of the plan-usage data the app's own Usage page shows. The internal
// route (server/routes/engine-limits.ts) decides which accounts this conversation may see.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const USAGE_LIMITS_TOOL = "usage_limits";
export const BOT_USAGE_TOOL = "usage";

export async function callBotUsageTool(args: Record<string, unknown>, context: Pick<ToolCallContext, "client">): Promise<ToolCallResult> {
  const query = new URLSearchParams();
  for (const field of ["period", "thread"] as const) {
    if (args[field] !== undefined) query.set(field, String(args[field]));
  }
  const { ok, body } = await context.client.apiResponse(query.size ? `/api/internal/usage?${query}` : "/api/internal/usage");
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "Bot usage could not be read."), isError: true };
}

export async function callUsageLimitsTool(context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/engine-limits");
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "Usage limits could not be read. Try again shortly."), isError: true };
}

export const USAGE_LIMITS_TOOL_DEFINITION = {
  name: USAGE_LIMITS_TOOL,
  description: "Each AI account's usage limits: percent used, reset time, when checked. status: ok, unknown (no data now; see why) or unsupported.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
};

export const BOT_USAGE_TOOL_DEFINITION = {
  name: BOT_USAGE_TOOL,
  description: "Read this bot's visible tokens, estimated cost and applicable usage caps before planning or handing off work. Periods are UTC. Omit thread for all visible conversations.",
  inputSchema: { type: "object", additionalProperties: false, properties: {
    period: { type: "string", enum: ["today", "month"], default: "today" },
    thread: { type: "string", enum: ["this"] },
  } },
};
