// Mid-turn sends wait here off the transcript (else they become the active leaf mid-turn) and survive Stop: stop-then-steer is the feature.

import { newId } from "./contracts.ts";
import { chatFollowups, saveChatFollowup, settleChatFollowups } from "./message-db.ts";
import { drainCoalesceHead } from "./admission.ts";
import { spokenLineFields } from "./live-call-record.ts";
import { workOriginSchema, type WorkOrigin } from "./peer-provenance.ts";
import type { ResolvedSender, SteerQueueReason } from "../shared/wire.ts";
import type { BotRecord, Message } from "./store.ts";
import type { UsageTrigger } from "./usage-ledger.ts";

export interface SteerStore {
  bot(id: string): BotRecord | null;
  projectBotForTask?(botId: string, threadId: string): BotRecord | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

interface QueueEntry {
  botId: string;
  items: Array<{
    messageId: string;
    text: string;
    prompt: string;
    replyToId?: string;
    sendId?: string;
    dataContext?: Message["dataContext"];
    reason?: SteerQueueReason;
    /** Queued by a bot running unattended: the drained turn inherits it (a queue is a delay, not a person at the keyboard). */
    unattended?: boolean;
    peerAsk?: Message["peerAsk"];
    origin?: WorkOrigin;
    sender?: ResolvedSender;
    trigger?: UsageTrigger;
    queuedAt: number;
    via?: "call";
    callId?: string;
    fromApp?: Message["fromApp"];
    reaction?: string;
    relay?: Message["relay"];
  }>;
}

export type SteerQueueHead = Pick<QueueEntry["items"][number], "trigger" | "sender" | "peerAsk" | "origin">;

const queues = new Map<string, QueueEntry>();

export interface HeldSteerQueue {
  botId: string;
  threadId: string;
  items: QueueEntry["items"];
}

export function restoreSteeredMessages(): void {
  queues.clear();
  for (const row of chatFollowups("bot")) {
    if (row.status !== "pending") continue;
    const entry = queues.get(row.threadId) ?? { botId: row.ownerId, items: [] };
    if (entry.botId !== row.ownerId) throw new Error("queued task belongs to another bot");
    const { via, callId, origin: storedOrigin, ...payload } = row.payload;
    const origin = workOriginSchema.safeParse(storedOrigin);
    entry.items.push({
      ...payload,
      ...spokenLineFields(via, callId),
      ...(origin.success ? { origin: origin.data } : {}),
      messageId: row.id,
      prompt: row.payload.prompt ?? row.payload.text,
      queuedAt: row.payload.queuedAt ?? Date.now(),
    });
    queues.set(row.threadId, entry);
  }
}
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) {
    try { listener(); }
    catch { console.warn("steer-queue: change listener failed"); }
  }
};

/** Public pending chips only: never expose provider prompts or reply context. */
export function queuedSteerSnapshot(ownsThread: (botId: string, threadId: string) => boolean):
  Record<string, Array<{ queueId: string; text: string; reason?: SteerQueueReason }>> {
  return Object.fromEntries([...queues]
    .filter(([threadId, entry]) => ownsThread(entry.botId, threadId))
    .map(([threadId, entry]) => [threadId, entry.items.map((item) => ({
      queueId: item.messageId, text: item.text, ...(item.reason ? { reason: item.reason } : {}),
    }))]));
}

export function onSteeredQueueChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export interface QueuedSteer {
  id: string;
}

export function queueSteeredMessage(
  botId: string,
  threadId: string,
  text: string,
  options: { prompt?: string; replyToId?: string; sendId?: string; dataContext?: Message["dataContext"]; reason?: SteerQueueReason; unattended?: boolean; peerAsk?: Message["peerAsk"]; origin?: WorkOrigin; sender?: ResolvedSender; trigger?: UsageTrigger; callId?: string; via?: "call"; reaction?: string; fromApp?: Message["fromApp"]; relay?: Message["relay"] } = {},
): QueuedSteer {
  const id = newId();
  const entry = queues.get(threadId) ?? { botId, items: [] };
  if (entry.botId !== botId) throw new Error("queued task belongs to another bot");
  const item = {
    messageId: id,
    text,
    prompt: options.prompt ?? text,
    replyToId: options.replyToId,
    sendId: options.sendId,
    dataContext: options.dataContext,
    reason: options.reason,
    unattended: options.unattended,
    peerAsk: options.peerAsk,
    ...(options.origin ? { origin: options.origin } : {}),
    sender: options.sender,
    trigger: options.trigger,
    queuedAt: Date.now(),
    ...spokenLineFields(options.via, options.callId),
    ...(options.fromApp ? { fromApp: options.fromApp } : {}),
    ...(options.reaction ? { reaction: options.reaction } : {}),
    ...(options.relay ? { relay: options.relay } : {}),
  };
  saveChatFollowup({ id, kind: "bot", ownerId: botId, threadId, payload: item });
  entry.items.push(item);
  queues.set(threadId, entry);
  changed();
  return { id };
}

export function queuedThreadPosition(botId: string, threadId: string): number | null {
  let position = 0;
  for (const [candidate, entry] of queues) {
    if (entry.botId !== botId || !entry.items.some((item) => item.reason === "capacity" || item.reason === "group-turn")) continue;
    position += 1;
    if (candidate === threadId) return position;
  }
  return null;
}

export function hasQueuedSteeredMessages(botId: string, threadId: string): boolean {
  const entry = queues.get(threadId);
  return entry?.botId === botId && entry.items.length > 0;
}

export function isSteeredMessageQueued(botId: string, threadId: string, queueId: string): boolean {
  const entry = queues.get(threadId);
  return entry?.botId === botId && entry.items.some((item) => item.messageId === queueId);
}

/** Entries leave the map before running, so racing settles never fire one queue twice; one coalesced group drains per settle. */
export function drainSteeredMessages(
  store: SteerStore,
  run: (
    botId: string,
    threadId: string,
    prompt: string,
    userMessage: Message,
    excludeIds: string[],
    unattended: boolean,
    head: SteerQueueHead,
  ) => void | Promise<void>,
  isBlocked?: (botId: string, threadId: string, head: SteerQueueHead) => boolean,
): void {
  // deleting only the entry being visited is safe under Map iteration
  for (const [threadId, entry] of queues) {
    const bot = store.projectBotForTask
      ? store.projectBotForTask(entry.botId, threadId)
      : store.bot(entry.botId);
    if (!bot) {
      settleChatFollowups(entry.items.map((item) => item.messageId), "cancelled");
      queues.delete(threadId);
      changed();
      continue;
    }
    if (bot.busy || isBlocked?.(entry.botId, threadId, entry.items[0])) continue;
    // isBlocked can re-enter this drain; if a nested drain took this entry, it is stale.
    if (queues.get(threadId) !== entry) continue;
    const group = drainCoalesceHead(entry.items, coalesceIdentity, (item) => item.queuedAt);
    const ids = group.map((item) => item.messageId);
    settleChatFollowups(ids, "dispatching");
    const rest = entry.items.slice(group.length);
    if (rest.length > 0) queues.set(threadId, { botId: entry.botId, items: rest });
    else queues.delete(threadId);
    changed();
    const appended: Message[] = [];
    for (const item of group) {
      appended.push(
        store.appendMessage(threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          sendId: item.sendId,
          ...(item.dataContext ? { dataContext: item.dataContext } : {}),
          queueId: item.messageId,
          peerAsk: item.peerAsk,
          sender: item.sender,
          ...spokenLineFields(item.via, item.callId),
          ...(item.fromApp ? { fromApp: item.fromApp } : {}),
          ...(item.relay ? { relay: item.relay } : {}),
          ...(item.reaction ? { reaction: item.reaction } : {}),
        }),
      );
    }
    const last = appended.at(-1);
    if (!last) continue;
    // A blank line keeps each message its own Markdown block; otherwise a trailing attachment tag merges into the next and stops being an image.
    const prompt = group.map((item) => item.prompt).join("\n\n");
    const running = run(
      entry.botId,
      threadId,
      prompt,
      last,
      appended.map((message) => message.id),
      // One unattended line makes the turn unattended: a person's words in the group cannot re-attend a bot's own.
      group.some((item) => item.unattended === true),
      { trigger: group[0].trigger, sender: group[0].sender, peerAsk: group[0].peerAsk, origin: group[0].origin },
    );
    void Promise.resolve(running).then(
      () => settleChatFollowups(ids, null),
      () => settleChatFollowups(ids, "interrupted"),
    ).catch((error) => console.warn("steer-queue: could not settle durable follow-up", error));
  }
}

/** Who sent it, provenance included: a bot's own work never merges with a person's texts, nor a spoken line with a typed one. */
function coalesceIdentity(item: QueueEntry["items"][number]): string {
  if (item.peerAsk?.incident) return "incident";
  if (item.peerAsk) return `peer:${item.peerAsk.botId}:${item.unattended === true ? "unattended" : "attended"}:${JSON.stringify(item.origin ?? null)}`;
  if (item.unattended === true) return "unattended";
  const person = item.sender ? `person:${item.sender.id ?? item.sender.name}` : "person:local";
  return item.via === "call" ? `call:${item.callId ?? ""}|${person}` : person;
}

export function queuedSteeredMessage(
  botId: string,
  threadId: string,
  sendId: string,
): { id: string; text: string; replyToId?: string; reason?: SteerQueueReason } | null {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId) return null;
  const item = entry.items.find((candidate) => candidate.sendId === sendId);
  return item ? { id: item.messageId, text: item.text, replyToId: item.replyToId, ...(item.reason ? { reason: item.reason } : {}) } : null;
}

export function cancelSteeredMessage(botId: string, messageId: string, expectedThreadId?: string): boolean {
  for (const [threadId, entry] of queues) {
    if (entry.botId !== botId || (expectedThreadId !== undefined && threadId !== expectedThreadId)) continue;
    const items = entry.items.filter((item) => item.messageId !== messageId);
    if (items.length === entry.items.length) continue;
    settleChatFollowups([messageId], "cancelled");
    if (items.length === 0) queues.delete(threadId);
    else queues.set(threadId, { botId: entry.botId, items });
    changed();
    return true;
  }
  return false;
}

/** The entry leaves first, so a racing settle cannot also dispatch these words; the caller must restore or settle it. */
export function holdSteeredQueue(botId: string, threadId: string, queueId: string): HeldSteerQueue | null {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId || !entry.items.some((item) => item.messageId === queueId)) return null;
  queues.delete(threadId);
  changed();
  return { botId, threadId, items: entry.items };
}

export function restoreHeldSteeredQueue(held: HeldSteerQueue): void {
  const existing = queues.get(held.threadId);
  if (existing && existing.botId !== held.botId) throw new Error("queued task belongs to another bot");
  queues.set(held.threadId, {
    botId: held.botId,
    items: existing ? [...held.items, ...existing.items] : held.items,
  });
  changed();
}

export function settleHeldSteeredQueue(held: HeldSteerQueue): void {
  settleChatFollowups(held.items.map((item) => item.messageId), null);
}

export function _queuedCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}
