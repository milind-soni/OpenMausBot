// The agents catalog's share tool and its internal route. The description is kept short: it is sent with every request
// that shows the Pages and apps group, and the tool's result carries the rest.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const SHARE_TOOL_NAMES: ReadonlySet<string> = new Set(["share"]);

export const SHARE_TOOL_DEFINITIONS = [
  {
    name: "share",
    description:
      "Share yourself (or, as Chief, your department) as a template, no chats, memory or keys: export shows a card; publish to the community GitHub, publish_to_repo to repo (path: its folder), add_to_team_library; import a link the person gave, list_team_library, import_from_team_library.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["export", "publish", "publish_to_repo", "add_to_team_library", "import", "list_team_library", "import_from_team_library"] },
        department: { type: "boolean" },
        url: { type: "string" },
        path: { type: "string" },
        slug: { type: "string" },
        repo: { type: "string" },
        direct: { type: "boolean" },
      },
      required: ["action"],
    },
  },
];

export async function callShareTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/share", { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "Done.") } : { text: String(body.error ?? "Sharing failed. Try again shortly."), isError: true };
}
