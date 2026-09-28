// Follow-up messages sent while a channel is working.
//
// The renderer must hand these to the harness immediately. Keeping them in a
// mounted composer loses the auto-send intent on navigation, reconnect, or a
// renderer reload. They stay off the transcript until the active channel
// operation settles so the current responder cannot appear to answer words it
// never saw.

import { newId } from "./contracts.ts";
import { chatFollowups, saveChatFollowup, settleChatFollowups } from "./message-db.ts";
import { drainCoalesceHead, DRAIN_COALESCE_MAX_ITEMS } from "./admission.ts";
import type { ResolvedSender } from "../shared/wire.ts";
import type { UsageTrigger } from "./usage-ledger.ts";

export interface ChannelQueueItem {
  id: string;
  text: string;
  replyToId?: string;
  sendId?: string;
  mode: "chat" | "goal";
  /** kept so the drain appends it with the same provenance it arrived with */
  via?: "api";
  /** the person who sent it, so the drained line still names them */
  sender?: ResolvedSender;
  /** who the ledger books the room turn it starts to, captured when sent */
  trigger?: UsageTrigger;
  /** when the words were queued (epoch ms): drain-time coalescing splits
   * one sender's items when the gap between them outgrows the window */
  queuedAt: number;
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
    entry.items.push({
      ...row.payload,
      id: row.id,
      mode: row.payload.mode ?? "chat",
      // rows queued before timestamps were kept read as queued at restore
      // time: the burst was still live when the restart interrupted it
      queuedAt: row.payload.queuedAt ?? Date.now(),
    });
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
    trigger?: UsageTrigger;
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
    trigger: options.trigger,
    queuedAt: Date.now(),
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
 * the HEAD can be lifted (the chip the UI offers Steer on): the success
 * path steers and settles the head GROUP — the leading coalesced run — as
 * one, so a request naming a later item must not lift the queue at all (it
 * would steer and delete words the requester did not name). The caller must
 * either restore the held queue or settle its head group. */
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
 * running turn — the whole head group steers as one — and re-queue the
 * rest for the room's one-coalesced-item-per-turn drain. A restart must
 * not replay the steered words as a fresh follow-up. */
export function settleHeldChannelQueueHead(held: HeldChannelQueue): void {
  const head = headChannelGroup(held.items);
  const rest = held.items.slice(head.length);
  settleChatFollowups(head.map((item) => item.id), null);
  if (rest.length === 0) return;
  const existing = queues.get(held.threadId);
  if (existing && existing.groupId !== held.groupId) throw new Error("queued task belongs to another channel");
  queues.set(held.threadId, {
    groupId: held.groupId,
    items: existing ? [...rest, ...existing.items] : rest,
  });
}

/**
 * Start at most one follow-up per idle channel: the leading coalesced
 * group — one sender's contiguous in-window burst — runs as ONE item.
 * Starting it synchronously marks the channel working again; its completion
 * calls this drain for the next group. Removing first makes repeated settle
 * notifications harmless.
 */
export function drainChannelMessages(
  isWorking: (groupId: string) => boolean,
  run: (input: { groupId: string; threadId: string; items: ChannelQueueItem[] }) => void | Promise<void>,
): void {
  for (const [threadId, entry] of queues) {
    if (isWorking(entry.groupId)) continue;
    if (entry.items.length === 0) {
      queues.delete(threadId);
      continue;
    }
    const group = headChannelGroup(entry.items);
    const ids = group.map((item) => item.id);
    settleChatFollowups(ids, "dispatching");
    entry.items.splice(0, group.length);
    if (entry.items.length === 0) queues.delete(threadId);
    const running = run({ groupId: entry.groupId, threadId, items: group });
    void Promise.resolve(running).then(
      () => settleChatFollowups(ids, null),
      () => settleChatFollowups(ids, "interrupted"),
    ).catch((error) => console.warn("channel-queue: could not settle durable follow-up", error));
  }
}

/** The leading run of queued room messages that drain as one item: same
 * sender, same provenance shape, each within the coalescing window of the
 * one before it, bounded at the room-context window — a room turn reads
 * the burst through that window, so a longer run would append lines the
 * responder never sees; the excess stays queued for the next turn. Manual
 * head-steer folds and settles exactly this group into the live turn. */
export function headChannelGroup(items: readonly ChannelQueueItem[]): ChannelQueueItem[] {
  return drainCoalesceHead(items, coalesceIdentity, (item) => item.queuedAt, DRAIN_COALESCE_MAX_ITEMS);
}

/** A queued room message's coalescing identity: WHO sent it, with the
 * provenance shape as part of the identity. A person's texts merge only
 * with that same person's; an API send has no person behind it, so it never
 * merges with anything, and neither does a goal (its coordinator routing
 * is per-send). Unattributed local sends (the loopback owner typing in the
 * room composer) are one identity — the transcript already names them all
 * the same. */
function coalesceIdentity(item: ChannelQueueItem): string {
  if (item.via === "api") return `api:${item.id}`;
  if (item.mode !== "chat") return `mode:${item.mode}:${item.id}`;
  if (item.sender) return `person:${item.sender.id ?? item.sender.name}`;
  return "person:local";
}

/** Test helper. */
export function _queuedChannelCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}
