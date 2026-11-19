import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const CHECK_BACK_TOOL_NAMES: ReadonlySet<string> = new Set(["check_back"]);

export async function callCheckBackTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/check-backs", { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The check-back did not go through. Try again shortly."), isError: true };
}

export const CHECK_BACK_TOOL_DEFINITIONS = [
  {
    name: "check_back",
    description: 'Come back to this chat later on your own; no one is asked. No args lists; cancel: id or "all".',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        when: { type: "string", description: '"in 2 hours", "Fri 9am" (person\'s zone) or ISO.' },
        note: { type: "string", description: "What to check then." },
        if: { type: "string", description: "Act only if this holds then." },
        cancel: { type: "string" },
      },
    },
  },
];
