// The agents catalog's what_changed tool: the differences between a document and its edited version, sentence by
// sentence, from the same comparison the chat's "What changed" view uses, so a bot reports what it changed from the
// files rather than from memory. Every bot on every engine has it; the internal route (server/routes/what-changed.ts)
// reads the files and runs the comparison off the server's event loop.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const WHAT_CHANGED_TOOL = "what_changed";

/** The internal request carries at most 1 MB (harness/http.ts readBody), so text passed inline must fit under it. */
export const WHAT_CHANGED_INLINE_MAX = 900_000;
export const WHAT_CHANGED_INLINE_REFUSAL = "Text passed directly may be about 900 KB in all. Save it to a file in your working folder (up to 2 MB each) and pass original_file / edited_file.";

export async function callWhatChangedTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const body = JSON.stringify(args);
  if (Buffer.byteLength(body, "utf8") > WHAT_CHANGED_INLINE_MAX) return { text: WHAT_CHANGED_INLINE_REFUSAL, isError: true };
  const { ok, body: answer } = await context.client.apiResponse("/api/internal/what-changed", { method: "POST", body });
  return ok ? { text: String(answer.text ?? "") } : { text: String(answer.error ?? "The comparison could not finish. Try again."), isError: true };
}

export const WHAT_CHANGED_TOOL_DEFINITION = {
  name: WHAT_CHANGED_TOOL,
  description: "What differs between a text and its edit: sentences changed ([-old-]{+new+}), added, removed, moved. Use before saying what you changed.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      original_file: { type: "string", description: "A .md/.txt you can read or attached here." },
      edited_file: { type: "string" },
      original_text: { type: "string" },
      edited_text: { type: "string" },
      start: { type: "integer" },
    },
  },
};
