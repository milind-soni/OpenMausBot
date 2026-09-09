// Follow-up messages sent while a channel is working.
//
// The renderer must hand these to the harness immediately. Keeping them in a
// mounted composer loses the auto-send intent on navigation, reconnect, or a
// renderer reload. They stay off the transcript until the active channel
// operation settles so the current responder cannot appear to answer words it
// never saw.

import { newId } from "./contracts.ts";

interface ChannelQueueItem {
  id: string;
  text: string;
  replyToId?: string;
  sendId?: string;
  mode: "chat" | "goal";
  /** kept so the drain appends it with the same provenance it arrived with */
  via?: "api";
}

interface ChannelQueueEntry {
  groupId: string;
  items: ChannelQueueItem[];
}

const queues = new Map<string, ChannelQueueEntry>(); // threadId -> waiting sends

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
  };
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
    if (items.length === 0) queues.delete(threadId);
    else queues.set(threadId, { groupId, items });
    return true;
  }
  return false;
}

/**
 * Start at most one follow-up per idle channel. Starting it synchronously
 * marks the channel working again; its completion calls this drain for the
 * next item. Removing first makes repeated settle notifications harmless.
 */
export function drainChannelMessages(
  isWorking: (groupId: string) => boolean,
  run: (input: ChannelQueueItem & { groupId: string; threadId: string }) => void,
): void {
  for (const [threadId, entry] of queues) {
    if (isWorking(entry.groupId)) continue;
    const item = entry.items.shift();
    if (!item) {
      queues.delete(threadId);
      continue;
    }
    if (entry.items.length === 0) queues.delete(threadId);
    run({ ...item, groupId: entry.groupId, threadId });
  }
}

/** Test helper. */
export function _queuedChannelCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}
