// MausBot's notification tools: read the unread notifications, then mark finished work read. The catalog shows them
// only to a MausBot; the internal route (server/routes/mausbot-notifications.ts) refuses every other bot regardless.
// The guidance lives in their results, so the descriptions that ride every MausBot turn stay short.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";
import { agentToolAnnotations } from "../agent-tool-policy.ts";

export const MAUSBOT_TOOL_NAMES: ReadonlySet<string> = new Set(["list_unread_notifications", "mark_notifications_read"]);

export async function callMausBotTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = name === "list_unread_notifications"
    ? await context.client.apiResponse("/api/internal/notifications")
    : await context.client.apiResponse("/api/internal/notifications/read", { method: "POST", body: JSON.stringify({ ids: args.ids }) });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "That could not be done."), isError: true };
}

export const MAUSBOT_TOOL_DEFINITIONS = [
  {
    name: "list_unread_notifications",
    description: "The person's unread notifications, newest first, when they ask what they missed or to tidy them up.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "mark_notifications_read",
    description: "Mark finished-work notifications read, by id from list_unread_notifications. Anything that needs the person stays unread.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ids: { type: "array", maxItems: 40, items: { type: "string" } } },
      required: ["ids"],
    },
  },
].map((tool) => {
  const annotations = agentToolAnnotations(tool.name);
  return annotations ? { ...tool, annotations } : tool;
});
