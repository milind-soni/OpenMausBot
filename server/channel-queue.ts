import { newId } from "./contracts.ts";
import { chatFollowups, saveChatFollowup, settleChatFollowups, type ChatFollowup } from "./message-db.ts";
import { drainCoalesceHead, DRAIN_COALESCE_MAX_ITEMS } from "./admission.ts";
import type { ResolvedSender } from "../shared/wire.ts";
import type { UsageTrigger } from "./usage-ledger.ts";
import type { Message } from "./store.ts";
import type { RoomPick } from "./room-pointed.ts";

export interface ChannelQueueItem {
  id: string;
  text: string;
  replyToId?: string;
  sendId?: string;
  mode: "chat" | "goal";
  via?: "api";
  sender?: ResolvedSender;
  trigger?: UsageTrigger;
  reaction?: string;
  /** Bot ids picked from the @ list; the turn that drains this line reads its @names with them. */
  mentions?: string[];
  /** What the person pointed at in a member's page; only that page's bot reads it. */
  pointed?: RoomPick;
  queuedAt: number;
  rowId?: string;
}

interface ChannelQueueEntry {
  groupId: string;
  items: ChannelQueueItem[];
}

const queues = new Map<string, ChannelQueueEntry>();

export function restoreChannelMessages(): void {
  queues.clear();
  for (const row of chatFollowups("channel")) {
    if (row.status !== "pending") continue;
    const entry = queues.get(row.threadId) ?? { groupId: row.ownerId, items: [] };
    if (entry.groupId !== row.ownerId) throw new Error("queued task belongs to another channel");
    // a channel line is only ever stamped "api"; "call" belongs to 1:1 rows
    const { via, ...payload } = row.payload;
    entry.items.push({
      ...payload,
      ...(via === "api" ? { via } : {}),
      id: row.id,
      mode: row.payload.mode ?? "chat",
      queuedAt: row.payload.queuedAt ?? Date.now(),
    });
    queues.set(row.threadId, entry);
  }
}

export interface QueuedChannelMessage {
  id: string;
  message?: Message;
}

export function queueChannelMessage(
  groupId: string,
  threadId: string,
  text: string,
  options: {
    record?: (followup: Omit<ChatFollowup, "status">) => Message;
    replyToId?: string;
    sendId?: string;
    mode?: "chat" | "goal";
    via?: "api";
    sender?: ResolvedSender;
    trigger?: UsageTrigger;
    reaction?: string;
    mentions?: string[];
    pointed?: RoomPick;
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
    ...(options.reaction ? { reaction: options.reaction } : {}),
    ...(options.mentions?.length ? { mentions: options.mentions } : {}),
    ...(options.pointed ? { pointed: options.pointed } : {}),
    queuedAt: Date.now(),
  };
  const followup = { id: item.id, kind: "channel" as const, ownerId: groupId, threadId, payload: item };
  const message = options.record?.(followup);
  if (!message) saveChatFollowup(followup);
  entry.items.push(message ? { ...item, rowId: message.id } : item);
  queues.set(threadId, entry);
  return { id: item.id, message };
}

export function queuedChannelMessage(
  groupId: string,
  threadId: string,
  sendId: string,
): ChannelQueueItem | null {
  const entry = queues.get(threadId);
  if (!entry || entry.groupId !== groupId) return null;
  return entry.items.find((item) => item.sendId === sendId) ?? null;
}

/** The waiting line under that id, and the conversation it waits in. */
export function channelQueueItem(groupId: string, queueId: string): { threadId: string; item: ChannelQueueItem } | null {
  for (const [threadId, entry] of queues) {
    const item = entry.groupId === groupId ? entry.items.find((candidate) => candidate.id === queueId) : undefined;
    if (item) return { threadId, item };
  }
  return null;
}

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

/** Removing first makes repeated settle notifications harmless. */
export function drainChannelMessages(
  isWorking: (groupId: string, threadId: string) => boolean,
  run: (input: { groupId: string; threadId: string; items: ChannelQueueItem[] }) => void | Promise<void>,
): void {
  for (const [threadId, entry] of queues) {
    if (isWorking(entry.groupId, threadId)) continue;
    if (entry.items.length === 0) {
      queues.delete(threadId);
      continue;
    }
    // A drained turn shares one routing target; an explicit steer keeps each line's reply context.
    const group = drainCoalesceHead(entry.items, (item) => JSON.stringify([coalesceIdentity(item), item.replyToId ?? null]),
      (item) => item.queuedAt, DRAIN_COALESCE_MAX_ITEMS);
    const ids = group.map((item) => item.id);
    settleChatFollowups(ids, "dispatching");
    entry.items.splice(0, group.length);
    if (entry.items.length === 0) queues.delete(threadId);
    let running: void | Promise<void>;
    try { running = run({ groupId: entry.groupId, threadId, items: group }); }
    catch (error) { console.warn("channel-queue: queued dispatch threw", error); running = Promise.reject(error); }
    void Promise.resolve(running).then(
      () => settleChatFollowups(ids, null),
      () => settleChatFollowups(ids, "interrupted"),
    ).catch((error) => console.warn("channel-queue: could not settle durable follow-up", error));
  }
}

export function headChannelGroup(items: readonly ChannelQueueItem[]): ChannelQueueItem[] {
  return drainCoalesceHead(items, coalesceIdentity, (item) => item.queuedAt, DRAIN_COALESCE_MAX_ITEMS);
}

function coalesceIdentity(item: ChannelQueueItem): string {
  if (item.via === "api") return `api:${item.id}`;
  if (item.mode !== "chat") return `mode:${item.mode}:${item.id}`;
  if (item.pointed) return `pointed:${item.id}`;
  return item.sender ? `person:${item.sender.id ?? item.sender.name}` : "person:local";
}

export function queuedChannelSends(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}

export const _queuedChannelCount = queuedChannelSends;

export function pendingChannelRows(threadId: string): Set<string> {
  return new Set(queues.get(threadId)?.items.flatMap((item) => item.rowId ? [item.rowId] : []));
}
