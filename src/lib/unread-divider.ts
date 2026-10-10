// Where the New divider goes when a conversation opens unread.
//
// The flag (Task.unread, Group.unread) says that something arrived while the
// person was away. Where is the later of two points they certainly saw: the
// newest message on screen when they last read the conversation
// (lastReadMessageId), and their own newest line. The divider sits above the
// first message after it. With neither point there is no divider, and none
// when nothing came in after it.
import { peerLine } from "@/lib/peer-message";
import type { Message } from "@/state/store";

type Line = Pick<Message, "id" | "role" | "text" | "peerAsk">;

/** A user-role line the person wrote, not one another bot delivered. */
const fromPerson = (message: Line) => message.role === "user" && !peerLine(message);

/** The first unread message of a conversation opened unread, or null. A
 * read cursor that is not among these messages (another branch, or older
 * than what is loaded) leaves only the person's own line to go by. */
export function firstUnreadMessageId(messages: readonly Line[], lastReadMessageId?: string): string | null {
  let seen = -1;
  for (let i = messages.length - 1; i >= 0 && seen < 0; i--) if (fromPerson(messages[i]!)) seen = i;
  if (lastReadMessageId) seen = Math.max(seen, messages.findIndex((message) => message.id === lastReadMessageId));
  return seen < 0 ? null : messages[seen + 1]?.id ?? null;
}

/** The read cursor of the conversation shown for this bot. */
export function threadReadCursor(bot: {
  threadId: string;
  tasks?: ReadonlyArray<{ threadId: string; lastReadMessageId?: string }> | null;
}): string | undefined {
  return bot.tasks?.find((task) => task.threadId === bot.threadId)?.lastReadMessageId;
}

/** The divider's message and every one after it, or null when the mounted
 * rows do not hold it. A list puts the divider above the first row that
 * draws one of these, so a hidden row under it does not lose it. */
export function unreadMessageIds(messages: readonly Pick<Message, "id">[], messageId: string | null): ReadonlySet<string> | null {
  if (!messageId) return null;
  const at = messages.findIndex((message) => message.id === messageId);
  return at < 0 ? null : new Set(messages.slice(at).map((message) => message.id));
}

/** Whether the conversation shown for this bot opens unread. A hidden
 * routine run is not a conversation, so it never does (#2007). */
export function threadOpensUnread(bot: {
  threadId: string;
  unread?: boolean;
  tasks?: ReadonlyArray<{ threadId: string; unread?: boolean; routineRunId?: string }> | null;
}): boolean {
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  if (task?.routineRunId) return false;
  return Boolean(task?.unread ?? bot.unread);
}

/** How long the divider stays once the person has caught up, then how long
 * it takes to fade and fold away. */
export const UNREAD_DIVIDER_LINGER_MS = 1200;
export const UNREAD_DIVIDER_FADE_MS = 480;
