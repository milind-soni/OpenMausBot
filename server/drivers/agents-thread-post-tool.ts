// The agents catalog's post_to_thread tool: one message into an existing thread, the bot's own or a reachable
// teammate's. The internal route (server/host/thread-posts.ts) checks reach, labels it as the bot's words and dedupes it.
import type { Json } from "./agents-client.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const THREAD_POST_TOOL = "post_to_thread";

export async function callThreadPostTool(args: Record<string, Json>, context: ToolCallContext): Promise<ToolCallResult> {
  const threadId = String(args.thread_id ?? "").trim();
  const message = String(args.message ?? "").trim();
  if (!threadId || !message) return { text: "post_to_thread needs thread_id (from list_threads) and message.", isError: true };
  const deliveryId = typeof args.delivery_id === "string" ? args.delivery_id.trim() : "";
  const r = await context.client.api("/api/internal/post-to-thread", {
    method: "POST",
    body: JSON.stringify({ fromBotId: context.botId, fromThreadId: context.threadId, toThreadId: threadId, message, wake: args.wake === true, ...(deliveryId ? { deliveryId } : {}) }),
  });
  if (r.error) return { text: String(r.error), isError: true };
  const where = `${r.botName ? `@${String(r.botName)}'s` : "the"} thread ${String(r.threadId ?? threadId)}`;
  return {
    text: r.duplicate === true
      ? `Already posted in ${where} with delivery_id ${String(r.deliveryId)}; not posted again.`
      : `Posted in ${where} (delivery_id ${String(r.deliveryId)}). ${r.woke === true ? "A run started there; nothing comes back to you." : "Nothing started: it is read on that thread's next run."}`,
  };
}

export const THREAD_POST_TOOL_DEFINITION = {
  name: THREAD_POST_TOOL,
  description:
    "Post one message into an open thread, yours or a teammate's (ids from list_threads). It shows as from you; that bot reads it as information, never as the person's request or approval. wake true also starts a run there; default false: it is read on that thread's next run. Rooms: post_to_room. Work: coordinate_bots.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      thread_id: { type: "string", description: "From list_threads." },
      message: { type: "string", maxLength: 8000, description: "The complete message." },
      wake: { type: "boolean", description: "True: start a run there now." },
      delivery_id: { type: "string", maxLength: 100, description: "Optional: the same id is posted only once." },
    },
    required: ["thread_id", "message"],
  },
};
