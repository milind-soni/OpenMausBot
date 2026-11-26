// The agents catalog's set_main_thread tool: a bot sets or clears its own main thread, as the person's "Set as main
// thread" does. The internal route (server/routes/internal-threads.ts) only takes the bot's own open conversations.
import type { Json } from "./agents-client.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const SET_MAIN_THREAD_TOOL = "set_main_thread";

export async function callSetMainThreadTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const clear = args.clear === true;
  if (args.thread_id != null && typeof args.thread_id !== "string") {
    return { text: "set_main_thread needs thread_id as a string from list_threads or start_thread; leave it out for this thread.", isError: true };
  }
  if (args.clear != null && typeof args.clear !== "boolean") return { text: "set_main_thread needs clear as true or false.", isError: true };
  const threadId = typeof args.thread_id === "string" ? args.thread_id.trim() : "";
  if (clear && threadId) return { text: "set_main_thread takes thread_id or clear, not both.", isError: true };
  const r = await context.client.api("/api/internal/main-thread", {
    method: "POST",
    body: JSON.stringify({ fromBotId: context.botId, fromThreadId: context.threadId, ...(clear ? { clear: true } : threadId ? { mainThreadId: threadId } : {}) }),
  });
  if (r.error) return { text: `Couldn't change your main thread: ${String(r.error)}`, isError: true };
  if (r.cleared) return { text: "Cleared your main thread choice: the app picks your main thread on its own again." };
  return { text: `#${String(r.title)} is now your main thread.` };
}

export const SET_MAIN_THREAD_TOOL_DEFINITION = {
  name: SET_MAIN_THREAD_TOOL,
  description:
    "Set or clear your own main thread (where your automations and briefs report). Only when the person or your instructions ask. "
    + "If they say main is stale or they work in another thread now, ask \"Make this thread your main chat?\" and call only after a yes.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      thread_id: { type: "string", description: "From list_threads or start_thread; default: this thread." },
      clear: { type: "boolean", description: "true: clear the choice instead." },
    },
  },
};
