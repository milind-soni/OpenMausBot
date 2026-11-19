import { decodeMessagePage, prepared, readStoredActiveLeaf } from "./message-db.ts";
import type { Message } from "./store.ts";
import type { ThreadState } from "./thread-cache.ts";

interface HistoryPage {
  messages: Message[];
  hasMore: boolean;
  activeLeafId: string | null;
}

function sliceBefore({ messages, activeLeafId }: ThreadState, before: string, limit: number): HistoryPage | null {
  const end = messages.findIndex((message) => message.id === before);
  if (end < 0) return null;
  const start = Math.max(0, end - limit);
  return { messages: messages.slice(start, end), hasMore: start > 0, activeLeafId };
}

const LAST_MESSAGE = "SELECT id FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1";
const EARLIER_MESSAGES = "SELECT json FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?";

function lastMessageId(threadId: string): string | null {
  return (prepared(LAST_MESSAGE).get(threadId) as { id: string } | undefined)?.id ?? null;
}

export function messagesBefore(
  threadId: string,
  before: string,
  limit: number,
  cached: ThreadState | undefined,
  loadThread: () => ThreadState,
): HistoryPage | null {
  if (cached) return sliceBefore(cached, before, limit);

  const cursor = prepared("SELECT rowid FROM messages WHERE thread_id = ? AND id = ?").get(threadId, before) as { rowid: number } | undefined;
  if (!cursor) {
    if (lastMessageId(threadId) !== null) return null;
    return sliceBefore(loadThread(), before, limit);
  }

  const rows = prepared(EARLIER_MESSAGES).all(threadId, cursor.rowid, limit + 1) as Array<{ json: string }>;
  const page = decodeMessagePage(rows, limit);
  if (page.messages.some((message) => message.parentId === undefined)) return sliceBefore(loadThread(), before, limit);

  return { ...page, activeLeafId: readStoredActiveLeaf(threadId) || lastMessageId(threadId) };
}
