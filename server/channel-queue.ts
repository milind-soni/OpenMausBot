// Follow-up messages sent while a channel is working.
//
// The renderer must hand these to the harness immediately. Keeping them in a
// mounted composer loses the auto-send intent on navigation, reconnect, or a
// renderer reload. They stay off the transcript until the active channel
// operation settles so the current responder cannot appear to answer words it
// never saw.

import { newId } from "./contracts.ts";
import { chatFollowups, saveChatFollowup, settleChatFollowups } from "./message-db.ts";
import type { ResolvedSender } from "../shared/wire.ts";

interface ChannelQueueItem {
  id: string;
  text: string;
  replyToId?: string;
  sendId?: string;
  mode: "chat" | "goal";
  /** kept so the drain appends it with the same provenance it arrived with */
  via?: "api";
  /** the person who sent it, so the drained line still names them */
  sender?: ResolvedSender;
}

interface ChannelQueueEntry {
  groupId: string;
  items: ChannelQueueItem[];
}

const queues = new Map<string, ChannelQueueEntry>(); // threadId -> waiting sends

export function restoreChannelMessages(): void {
  queues.clear();
  for (const row of chatFollowups("channel")) {
    if (row.status !== "pending") continue;
    const entry = queues.get(row.threadId) ?? { groupId: row.ownerId, items: [] };
    if (entry.groupId !== row.ownerId) throw new Error("queued task belongs to another channel");
    entry.items.push({ ...row.payload, id: row.id, mode: row.payload.mode ?? "chat" });
    queues.set(row.threadId, entry);
  }
}

export interface QueuedChannelMessage {
  id: string;
}

export function queueChannelMessage(
  groupId: string,
  threadId: string,
  text: string,
  options: {
    replyToId?: string;
    sendId?: string;
    mode?: "chat" | "goal";
    via?: "api";
    sender?: ResolvedSender;
  } = {},
): QueuedChannelMessage {
  const entry = queues.get(threadId) ?? { groupId, items: [] };
  if (entry.groupId !== groupId) throw new Error("queued task belongs to another channel");
  const item: ChannelQueueItem = {
    id: newId(),
    text,
    replyToId: options.replyToId,
    sendId: options.sendId,
    mode: options.mode ?? "chat",
    via: options.via,
    sender: options.sender,
  };
  saveChatFollowup({ id: item.id, kind: "channel", ownerId: groupId, threadId, payload: item });
  entry.items.push(item);
  queues.set(threadId, entry);
  return { id: item.id };
}

/** Find the stable receipt for an HTTP retry that is still waiting. */
export function queuedChannelMessage(
  groupId: string,
  threadId: string,
  sendId: string,
): ChannelQueueItem | null {
  const entry = queues.get(threadId);
  if (!entry || entry.groupId !== groupId) return null;
  return entry.items.find((item) => item.sendId === sendId) ?? null;
}

/** Remove one queued message before it starts. */
export function cancelChannelMessage(groupId: string, queueId: string): boolean {
  for (const [threadId, entry] of queues) {
    if (entry.groupId !== groupId) continue;
    const items = entry.items.filter((item) => item.id !== queueId);
    if (items.length === entry.items.length) continue;
    settleChatFollowups([queueId], "cancelled");
    if (items.length === 0) queues.delete(threadId);
    else queues.set(threadId, { groupId, items });
    return true;
  }
  return false;
}

/** A channel thread's queue lifted out of the map while a live steer is
 * attempted against the room's running speaker. */
export interface HeldChannelQueue {
  groupId: string;
  threadId: string;
  items: ChannelQueueItem[];
}

/** Atomically lift a channel thread's whole queue out for a live steer. The
 * entry leaves first so a room that settles while the adapter is still
 * thinking can never also drain the same words as a follow-up turn. Only
 * the HEAD can be lifted: the success path steers and settles items[0], so
 * a request naming a later item must not lift the queue at all (it would
 * steer and delete a different message's words). The caller must either
 * restore the held queue or settle its head. */
export function holdChannelQueue(groupId: string, threadId: string, queueId: string): HeldChannelQueue | null {
  const entry = queues.get(threadId);
  if (!entry || entry.groupId !== groupId || entry.items[0]?.id !== queueId) return null;
  queues.delete(threadId);
  return { groupId, threadId, items: entry.items };
}

/** Put a held queue back after the steer was refused. Words queued while the
 * hold was open keep their place behind the restored items. */
export function restoreHeldChannelQueue(held: HeldChannelQueue): void {
  const existing = queues.get(held.threadId);
  if (existing && existing.groupId !== held.groupId) throw new Error("queued task belongs to another channel");
  queues.set(held.threadId, {
    groupId: held.groupId,
    items: existing ? [...held.items, ...existing.items] : held.items,
  });
}

/** Resolve the held head's reply target through a caller-supplied resolver.
 * The queue is already lifted out of the map here, so a target that cannot
 * be resolved (missing, non-text, empty — state drift between queueing and
 * the steer) must not strand the held words outside it until restart:
 * restore first, then let the error propagate to the request. */
export function resolveHeldReplyTarget<T>(
  held: HeldChannelQueue,
  resolve: (threadId: string, replyToId: string) => T,
): T | undefined {
  const head = held.items[0];
  if (!head?.replyToId) return undefined;
  try {
    return resolve(held.threadId, head.replyToId);
  } catch (error) {
    restoreHeldChannelQueue(held);
    throw error;
  }
}

/** Mark a held queue's head delivered — its words were folded into the
 * running turn — and re-queue the rest for the room's normal one-at-a-time
 * drain. A restart must not replay the steered head as a fresh follow-up. */
export function settleHeldChannelQueueHead(held: HeldChannelQueue): void {
  const [head, ...rest] = held.items;
  settleChatFollowups([head.id], null);
  if (rest.length === 0) return;
  const existing = queues.get(held.threadId);
  if (existing && existing.groupId !== held.groupId) throw new Error("queued task belongs to another channel");
  queues.set(held.threadId, {
    groupId: held.groupId,
    items: existing ? [...rest, ...existing.items] : rest,
  });
}

/**
 * Start at most one follow-up per idle channel. Starting it synchronously
 * marks the channel working again; its completion calls this drain for the
 * next item. Removing first makes repeated settle notifications harmless.
 */
export function drainChannelMessages(
  isWorking: (groupId: string) => boolean,
  run: (input: ChannelQueueItem & { groupId: string; threadId: string }) => void | Promise<void>,
): void {
  for (const [threadId, entry] of queues) {
    if (isWorking(entry.groupId)) continue;
    const item = entry.items[0];
    if (!item) {
      queues.delete(threadId);
      continue;
    }
    settleChatFollowups([item.id], "dispatching");
    entry.items.shift();
    if (entry.items.length === 0) queues.delete(threadId);
    const running = run({ ...item, groupId: entry.groupId, threadId });
    void Promise.resolve(running).then(
      () => settleChatFollowups([item.id], null),
      () => settleChatFollowups([item.id], "interrupted"),
    ).catch((error) => console.warn("channel-queue: could not settle durable follow-up", error));
  }
}

/** Test helper. */
export function _queuedChannelCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}
