import { redactSecretsInText } from "../../shared/redact.ts";
import { TOOL_RESULT_MAX_CHARS, TOOL_RESULT_PREVIEW_CHARS, toolResultPrefix } from "../tool-results.ts";

const fmt = (n: number) => n.toLocaleString("en-US");

/** The operation already happened. Saving overflow must never retry it or
 * turn a successful operation into a failed MCP call. Only cache I/O is timed. */
export async function boundedAgentResult(text: string, save: (text: string, truncated: boolean) => Promise<unknown>): Promise<string> {
  if (text.length <= 24_000) return text;
  const redacted = redactSecretsInText(text);
  const prefix = toolResultPrefix(redacted, TOOL_RESULT_PREVIEW_CHARS);
  const retained = toolResultPrefix(redacted, TOOL_RESULT_MAX_CHARS);
  const truncated = retained.length < redacted.length;
  try {
    const saved = await save(retained, truncated) as { id?: unknown; truncated?: unknown; summary?: unknown } | null;
    if (!saved || typeof saved.id !== "string" || !/^r-[0-9a-f-]{36}$/.test(saved.id)) throw new Error("Invalid saved result");
    // The harness's triage stage (server/tool-triage.ts) ran while saving. A
    // checked summary replaces the preview; anything else — stage off, under
    // threshold, or a refused check — keeps today's capped preview, so raw
    // bytes stay in context exactly as before.
    const summary = typeof saved.summary === "string" ? saved.summary.trim() : "";
    if (summary) {
      return `${summary}\n\n[OpenMausBot summarized this large tool result: ${fmt(retained.length)} → ${fmt(summary.length)} characters. The redacted original is saved in full${truncated || saved.truncated ? " up to the storage limit" : ""}; read it with tool_result_read id "${saved.id}" and offset 0. A summarized result is cached for one hour; restart or cache pressure can drop it, and its durable copy extends retrieval up to 30 days. Do not repeat an action just to retrieve its output.]`;
    }
    return `${prefix}\n\n[Large tool result: showing the first ${prefix.length} characters. ${truncated || saved.truncated
      ? "Only a bounded portion was retained; the remaining tail was omitted."
      : "The remaining redacted result is temporarily saved."} If a missing detail is needed, call tool_result_read with id "${saved.id}" and offset ${prefix.length}. Saved results expire after one hour, on app restart, or under cache pressure. Do not repeat an action just to retrieve its output.]`;
  } catch {
    return `${prefix}\n\n[Large tool result: showing the first ${prefix.length} characters. The remaining output could not be saved. The original operation was not retried. Do not repeat an action just to retrieve its output.]`;
  }
}
