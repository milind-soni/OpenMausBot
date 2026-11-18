import { peerLine } from "@/lib/peer-message";
import type { Message } from "@/state/store";

type Line = Pick<Message, "id" | "role" | "text" | "peerAsk">;

const fromPerson = (message: Line) => message.role === "user" && !peerLine(message);

export function firstUnreadMessageId(messages: readonly Line[], lastReadMessageId?: string): string | null {
  let seen = -1;
  for (let i = messages.length - 1; i >= 0 && seen < 0; i--) if (fromPerson(messages[i]!)) seen = i;
  if (lastReadMessageId) seen = Math.max(seen, messages.findIndex((message) => message.id === lastReadMessageId));
  return seen < 0 ? null : messages[seen + 1]?.id ?? null;
}

export type UnreadDivider = { threadId: string; messageId: string | null; lastReadMessageId?: string };

// A short switch page can end below the boundary: keep the cursor so a scrollback page can place it.
export function unreadDividerFor(threadId: string, messages: readonly Line[], lastReadMessageId: string | undefined, hasMore?: boolean): UnreadDivider | null {
  const messageId = firstUnreadMessageId(messages, lastReadMessageId);
  if (messageId) return { threadId, messageId };
  return hasMore ? { threadId, messageId: null, lastReadMessageId } : null;
}

export function placeUnreadDivider(divider: UnreadDivider | null, threadId: string, messages: readonly Line[], hasMore: boolean): UnreadDivider | null {
  if (!divider || divider.threadId !== threadId || divider.messageId) return divider;
  return unreadDividerFor(threadId, messages, divider.lastReadMessageId, hasMore);
}

export function threadReadCursor(bot: {
  threadId: string;
  tasks?: ReadonlyArray<{ threadId: string; lastReadMessageId?: string }> | null;
}): string | undefined {
  return bot.tasks?.find((task) => task.threadId === bot.threadId)?.lastReadMessageId;
}

export function unreadMessageIds(messages: readonly Pick<Message, "id">[], messageId: string | null): ReadonlySet<string> | null {
  if (!messageId) return null;
  const at = messages.findIndex((message) => message.id === messageId);
  return at < 0 ? null : new Set(messages.slice(at).map((message) => message.id));
}

export function threadOpensUnread(bot: {
  threadId: string;
  unread?: boolean;
  tasks?: ReadonlyArray<{ threadId: string; unread?: boolean; routineRunId?: string }> | null;
}): boolean {
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  if (task?.routineRunId) return false;
  return Boolean(task?.unread ?? bot.unread);
}

export const UNREAD_DIVIDER_LINGER_MS = 1200;
export const UNREAD_DIVIDER_FADE_MS = 480;
