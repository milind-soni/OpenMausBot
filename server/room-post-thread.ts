import { fitsOnOneLine } from "./bot-profile.ts";
import type { GroupRecord, GroupTaskRecord, Message, Store } from "./store.ts";

export const NEW_THREAD_TITLE_REFUSAL = "new_thread must be the new thread's title: one line of at most 80 characters";

export function newThreadTitle(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined;
  const title = typeof raw === "string" ? raw.trim() : "";
  return title && title.length <= 80 && fitsOnOneLine(title) ? title : null;
}

/** Read fresh every time; a line stamped via the HTTP API does not count, so a bot cannot re-arm the ceiling it just spent. */
export function lastHumanRoomMessageAt(store: Pick<Store, "messagesFor">, group: GroupRecord): number | undefined {
  let latest: number | undefined;
  for (const threadId of new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])) {
    const at = store.messagesFor(threadId).findLast((message) => message.role === "user" && message.kind === "text" && !message.via)?.at;
    if (at !== undefined && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

export function postToRoomThread(store: Pick<Store, "createGroupTask" | "appendMessage" | "deleteGroupTask">, room: GroupRecord, newThread: string | undefined,
  message: Omit<Message, "id" | "at">): { opened: GroupTaskRecord | null; posted: Message } | null {
  const opened = newThread ? store.createGroupTask(room.id, newThread, false) : null;
  if (newThread && !opened) return null;
  try {
    return { opened, posted: store.appendMessage(opened?.threadId ?? room.threadId, message) };
  } catch (error) {
    if (opened) {
      try {
        store.deleteGroupTask(room.id, opened.threadId);
      } catch (cleanup) {
        console.error(`room post: could not remove the empty thread ${opened.threadId} after its post failed`, cleanup);
      }
    }
    throw error;
  }
}
