import type { Store } from "./store.ts";

type Line = { role: string; kind?: string };
const NOT_A_REPLY = new Set(["activity", "screen", "digest", "compaction"]);

/** A bot's line the person reads: a reply, a routine's report, another bot's handoff or a notice; not its working trail. */
export const isReply = (message: Line): boolean => message.role === "bot" && !NOT_A_REPLY.has(message.kind ?? "text");

/** A conversation the person marked unread stays so until something new arrives in it: any reply ends the mark, whatever
 * wrote it, so no window keeps holding a conversation that has news. */
export function endHeldUnread(store: Pick<Store, "botByThread" | "taskByThread" | "patchTask">, threadId: string, message: Line): void {
  const bot = isReply(message) ? store.botByThread(threadId) : null;
  if (bot && store.taskByThread(bot.id, threadId)?.heldUnread !== undefined) store.patchTask(bot.id, threadId, { heldUnread: undefined });
}
