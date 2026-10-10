import { redactSecretsInText } from "../../shared/redact.ts";
import { TOOL_RESULT_MAX_CHARS, TOOL_RESULT_PREVIEW_CHARS, toolResultPrefix } from "../tool-results.ts";

/** The operation already happened. Saving overflow must never retry it or
 * turn a successful operation into a failed MCP call. Only cache I/O is timed. */
export async function boundedAgentResult(text: string, save: (text: string, truncated: boolean) => Promise<unknown>): Promise<string> {
  if (text.length <= 24_000) return text;
  const redacted = redactSecretsInText(text);
  const prefix = toolResultPrefix(redacted, TOOL_RESULT_PREVIEW_CHARS);
  const retained = toolResultPrefix(redacted, TOOL_RESULT_MAX_CHARS);
  const truncated = retained.length < redacted.length;
  try {
    const saved = await save(retained, truncated) as { id?: unknown; truncated?: unknown } | null;
    if (!saved || typeof saved.id !== "string" || !/^r-[0-9a-f-]{36}$/.test(saved.id)) throw new Error("Invalid saved result");
    return `${prefix}\n\n[Large tool result: showing the first ${prefix.length} characters. ${truncated || saved.truncated
      ? "Only a bounded portion was retained; the remaining tail was omitted."
      : "The remaining redacted result is temporarily saved."} If a missing detail is needed, call tool_result_read with id "${saved.id}" and offset ${prefix.length}. Saved results expire after one hour, on app restart, or under cache pressure. Do not repeat an action just to retrieve its output.]`;
  } catch {
    return `${prefix}\n\n[Large tool result: showing the first ${prefix.length} characters. The remaining output could not be saved. The original operation was not retried. Do not repeat an action just to retrieve its output.]`;
  }
}
