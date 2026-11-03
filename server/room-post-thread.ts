import { fitsOnOneLine } from "./bot-profile.ts";
import type { GroupRecord, Store } from "./store.ts";

export const NEW_THREAD_TITLE_REFUSAL = "new_thread must be the new thread's title: one line of at most 80 characters";

export function newThreadTitle(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined;
  const title = typeof raw === "string" ? raw.trim() : "";
  return title && title.length <= 80 && fitsOnOneLine(title) ? title : null;
}

/** Read fresh every time; a line stamped via the HTTP API does not count, so a bot cannot re-arm the ceiling it just spent. */
export function lastHumanRoomMessageAt(store: Pick<Store, "messagesFor">, group: GroupRecord): number | undefined {
  const threads = new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]);
  const latest = Math.max(...[...threads].map((threadId) =>
    store.messagesFor(threadId).findLast((message) => message.role === "user" && message.kind === "text" && !message.via)?.at ?? -Infinity));
  return Number.isFinite(latest) ? latest : undefined;
}
