// The agents catalog's what_changed tool: the differences between a document and its edited version, sentence by
// sentence, from the same comparison the chat's "What changed" view uses, so a bot reports what it changed from the
// files rather than from memory. Every bot on every engine has it; the internal route (server/routes/what-changed.ts)
// reads the files and runs the comparison off the server's event loop.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const WHAT_CHANGED_TOOL = "what_changed";

export async function callWhatChangedTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/what-changed", { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The comparison could not finish. Try again."), isError: true };
}

export const WHAT_CHANGED_TOOL_DEFINITION = {
  name: WHAT_CHANGED_TOOL,
  description: "Exactly what differs between a text and its edited version: sentences changed ([-old-]{+new+}), added, removed or moved, by paragraph. Use before saying what you changed, or to check an edit.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      original_file: { type: "string", description: ".md or .txt in your working folder or attached here." },
      edited_file: { type: "string" },
      original_text: { type: "string", description: "Instead of a file." },
      edited_text: { type: "string" },
      start: { type: "integer", description: "Continue a long list from this change." },
    },
  },
};
