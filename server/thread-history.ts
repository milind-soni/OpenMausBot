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

function sliceAround({ messages, activeLeafId }: ThreadState, messageId: string, limit: number): HistoryPage | null {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return null;
  const before = Math.floor((limit - 1) / 2);
  const start = Math.max(0, Math.min(index - before, messages.length - limit));
  const stop = Math.min(messages.length, start + limit);
  return { messages: messages.slice(start, stop), hasMore: start > 0, activeLeafId };
}

const LAST_MESSAGE = "SELECT id FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1";
const MESSAGE_ROW = "SELECT rowid FROM messages WHERE thread_id = ? AND id = ?";
const LATER_MESSAGES = "SELECT json FROM messages WHERE thread_id = ? AND rowid >= ? ORDER BY rowid LIMIT ?";
const EARLIER_MESSAGES = "SELECT json FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?";

export function lastMessageId(threadId: string): string | null {
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

  const cursor = prepared(MESSAGE_ROW).get(threadId, before) as { rowid: number } | undefined;
  if (!cursor) {
    if (lastMessageId(threadId) !== null) return null;
    return sliceBefore(loadThread(), before, limit);
  }

  const rows = prepared(EARLIER_MESSAGES).all(threadId, cursor.rowid, limit + 1) as Array<{ json: string }>;
  const page = decodeMessagePage(rows, limit);
  if (page.messages.some((message) => message.parentId === undefined)) return sliceBefore(loadThread(), before, limit);

  return { ...page, activeLeafId: readStoredActiveLeaf(threadId) || lastMessageId(threadId) };
}

/** The page of `limit` messages with `messageId` in its middle, pushed back from either end of the conversation. */
export function messagesAround(threadId: string, messageId: string, limit: number, loadThread: () => ThreadState): HistoryPage | null {
  if (limit < 1) return sliceAround(loadThread(), messageId, limit);

  const cursor = prepared(MESSAGE_ROW).get(threadId, messageId) as { rowid: number } | undefined;
  if (!cursor) return lastMessageId(threadId) === null ? sliceAround(loadThread(), messageId, limit) : null;

  const earlier = decodeMessagePage(prepared(EARLIER_MESSAGES).all(threadId, cursor.rowid, limit + 1) as Array<{ json: string }>, limit);
  const later = (prepared(LATER_MESSAGES).all(threadId, cursor.rowid, limit) as Array<{ json: string }>).map((row) => JSON.parse(row.json) as Message);
  const near = [...earlier.messages, ...later];
  if (near.some((message) => message.parentId === undefined)) return sliceAround(loadThread(), messageId, limit);

  const page = sliceAround({ messages: near, activeLeafId: readStoredActiveLeaf(threadId) || lastMessageId(threadId) }, messageId, limit)!;
  return { ...page, hasMore: page.hasMore || earlier.hasMore };
}
