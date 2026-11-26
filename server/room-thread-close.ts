import type { RoomThreadCloser } from "../shared/room-threads.ts";
import { endHeldUnread, isReply } from "./held-unread.ts";
import type { Store } from "./store.ts";

type Line = { role: string; kind?: string };
type CloseStore = Pick<Store, "groupByThread" | "groupTaskByThread" | "patchGroupTask">;

/** A bot's close of the room thread its turn speaks in waits for that turn to end, so its own reply does not open the
 * thread again. Keyed by thread: a room thread has one speaker at a time. */
const closesAtTurnEnd = new Map<string, RoomThreadCloser>();

export function setRoomThreadClosed(store: Pick<Store, "patchGroupTask">, groupId: string, threadId: string, by: RoomThreadCloser | null) {
  return store.patchGroupTask(groupId, threadId, { closed: by ? { at: Date.now(), by } : null });
}

export function closeRoomThreadAtTurnEnd(threadId: string, bot: { id: string; name: string }): void {
  closesAtTurnEnd.set(threadId, { kind: "bot", id: bot.id, name: bot.name });
}

export function settleRoomThreadClose(store: Pick<Store, "groupTaskByThread" | "patchGroupTask">, groupId: string, threadId: string): void {
  const by = closesAtTurnEnd.get(threadId);
  if (!by) return;
  closesAtTurnEnd.delete(threadId);
  const task = store.groupTaskByThread(groupId, threadId);
  if (task && task.closedAt === undefined) setRoomThreadClosed(store, groupId, threadId, by);
}

/** A person's line or a bot's reply in a closed room thread opens it again, so nothing new hides under a fold. A
 * person's line also cancels a close the answering bot asked for, since that bot has not read it. */
function reopenOnLine(store: CloseStore, threadId: string, line: Line): void {
  const person = line.role === "user";
  if (!person && !isReply(line)) return;
  if (person) closesAtTurnEnd.delete(threadId);
  const group = store.groupByThread(threadId);
  if (!group || group.dm) return;
  if (store.groupTaskByThread(group.id, threadId)?.closedAt !== undefined) setRoomThreadClosed(store, group.id, threadId, null);
}

export function afterNewLine(store: CloseStore & Parameters<typeof endHeldUnread>[0], threadId: string, line: Line): void {
  endHeldUnread(store, threadId, line);
  reopenOnLine(store, threadId, line);
}
