// The agents catalog's share tool and its internal route. The description is kept short: it is sent with every request
// that shows the Pages and apps group, and the tool's result carries the rest.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const SHARE_TOOL_NAMES: ReadonlySet<string> = new Set(["share"]);

export const SHARE_TOOL_DEFINITIONS = [
  {
    name: "share",
    description:
      "Share yourself (or, as Chief, your department) as a template: no chats, memory or keys. export shows a card; publish puts it on the community GitHub; import adds one the person linked.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["export", "publish", "import"] },
        department: { type: "boolean" },
        url: { type: "string" },
        path: { type: "string" },
      },
      required: ["action"],
    },
  },
];

export async function callShareTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/share", { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "Done.") } : { text: String(body.error ?? "Sharing failed. Try again shortly."), isError: true };
}
