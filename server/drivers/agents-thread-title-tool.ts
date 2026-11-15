// The agents catalog's rename_thread tool: a bot names the thread it is working in. The internal route
// (server/routes/internal-threads.ts) renames only that thread; a room's thread and an automation's chat keep their names.
import type { Json } from "./agents-client.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const RENAME_THREAD_TOOL = "rename_thread";

export async function callRenameThreadTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const title = String(args.title ?? "").trim();
  if (!title) return { text: "rename_thread needs title: one short line saying what this thread is about.", isError: true };
  const r = await context.client.api("/api/internal/thread-title", {
    method: "POST",
    body: JSON.stringify({ fromBotId: context.botId, fromThreadId: context.threadId, title }),
  });
  if (r.error) return { text: `Couldn't rename this thread: ${String(r.error)}`, isError: true };
  return { text: `Renamed this thread to #${String(r.title)} (it was #${String(r.previous)}).` };
}

export const RENAME_THREAD_TOOL_DEFINITION = {
  name: RENAME_THREAD_TOOL,
  description:
    "Rename the thread you are in so the sidebar says what it is about (\"Acme: carousel design\"): when the person asks, or when the title is only the cut start of the first message. Never rename a thread the person named unless asked. Rooms and automation chats keep their names.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { title: { type: "string", description: "One short, specific line, at most 80 characters." } },
    required: ["title"],
  },
};
