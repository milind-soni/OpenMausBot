// The watch_list tool: one change to the calling bot's own watch list. The arguments are checked here and again by the
// server, which reads the same raw arguments.
import { parseWatchInput } from "../../shared/watch-list.ts";

import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export async function callWatchTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const parsed = parseWatchInput(args);
  if (!parsed.ok) return { text: parsed.error, isError: true };
  const { ok, status, body } = await context.client.apiResponse("/api/internal/watch-list", { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.message ?? "Done.") } : { text: String(body.error ?? `HTTP ${status}`), isError: true };
}
