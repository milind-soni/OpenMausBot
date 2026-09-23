// Queue-and-steer for busy 1:1 bots.
//
// A message sent to a bot mid-turn used to bounce with a 409. Now it waits
// here until the bot settles, then lands in the thread and runs as ONE
// follow-up turn whose prompt is the queued texts separated by a blank line.
//
// The durable queue is NOT in `messages[]` while the current
// turn is running: appending immediately would make the queued line the
// active leaf, so remaining tool/assistant events of *this* turn would
// hang off a user line the model has not seen. Restart restores only sends
// whose dispatch has not begun. The composer shows a pending chip
// until drain appends the words.
//
// Unlike the delegation drain, an interrupted or failed turn does NOT
// discard this queue: delegations are a bot's fan-out (dropping them on
// Stop is a safety property), but these are the user's own words —
// stop-then-steer (queue a correction, hit Stop, the correction runs) is
// the feature.

import { newId } from "./contracts.ts";
import { chatFollowups, saveChatFollowup, settleChatFollowups } from "./message-db.ts";
import type { ResolvedSender } from "../shared/wire.ts";
import type { BotRecord, Message } from "./store.ts";

/** The slice of Store this module needs — narrow so tests can fake it. */
export interface SteerStore {
  bot(id: string): BotRecord | null;
  projectBotForTask?(botId: string, threadId: string): BotRecord | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

interface QueueEntry {
  /** Keep ownership pinned even when the selected task changes. */
  botId: string;
  items: Array<{
    messageId: string;
    text: string;
    prompt: string;
    replyToId?: string;
    sendId?: string;
    reason?: "capacity";
    /** The words were queued by a bot already running unattended (a
     * thread it opened on itself). The drained turn must inherit that:
     * a queue is a delay, not a person sitting down at the keyboard. */
    unattended?: boolean;
    peerAsk?: Message["peerAsk"];
    /** The person who sent the words: a queue is a delay, not a change of
     * author, so the drained line names them like an immediate send would. */
    sender?: ResolvedSender;
  }>;
}

const queues = new Map<string, QueueEntry>(); // threadId → waiting sends

/** A thread's queue lifted out of the map while a live steer is attempted. */
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
    entry.items.push({ ...row.payload, messageId: row.id, prompt: row.payload.prompt ?? row.payload.text });
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
  Record<string, Array<{ queueId: string; text: string; reason?: "capacity" }>> {
  return Object.fromEntries([...queues]
    .filter(([threadId, entry]) => ownsThread(entry.botId, threadId))
    .map(([threadId, entry]) => [threadId, entry.items.map((item) => ({
      queueId: item.messageId, text: item.text, ...(item.reason ? { reason: item.reason } : {}),
    }))]));
}

/** Publish changes synchronously so every client can restore/cancel the queue. */
export function onSteeredQueueChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export interface QueuedSteer {
  id: string;
}

/** Hold a mid-turn send off the transcript until drain. */
export function queueSteeredMessage(
  botId: string,
  threadId: string,
  text: string,
  options: { prompt?: string; replyToId?: string; sendId?: string; reason?: "capacity"; unattended?: boolean; peerAsk?: Message["peerAsk"]; sender?: ResolvedSender } = {},
): QueuedSteer {
  const id = newId();
  const entry = queues.get(threadId) ?? { botId, items: [] };
  // A thread cannot legitimately change owners. Refuse to merge unrelated
  // queues even if a corrupt caller reuses a thread id.
  if (entry.botId !== botId) throw new Error("queued task belongs to another bot");
  const item = {
    messageId: id,
    text,
    prompt: options.prompt ?? text,
    replyToId: options.replyToId,
    sendId: options.sendId,
    reason: options.reason,
    unattended: options.unattended,
    peerAsk: options.peerAsk,
    sender: options.sender,
  };
  saveChatFollowup({ id, kind: "bot", ownerId: botId, threadId, payload: item });
  entry.items.push(item);
  queues.set(threadId, entry);
  changed();
  return { id };
}

/** Where a thread stands among this bot's threads waiting for a free slot:
 * 1 for the next to start. The drain visits queues in insertion order, so
 * insertion order is the line. Null when nothing of this bot's is waiting
 * on that thread. */
export function queuedThreadPosition(botId: string, threadId: string): number | null {
  let position = 0;
  for (const [candidate, entry] of queues) {
    if (entry.botId !== botId || !entry.items.some((item) => item.reason === "capacity")) continue;
    position += 1;
    if (candidate === threadId) return position;
  }
  return null;
}

/** Any queued correction supersedes a tool-planned continuation, whether it
 * waits for this thread's turn or for the bot's shared capacity. */
export function hasQueuedSteeredMessages(botId: string, threadId: string): boolean {
  const entry = queues.get(threadId);
  return entry?.botId === botId && entry.items.length > 0;
}

/** Drain every queue whose task is idle: append the held lines (leaf is now
 * the finished turn's last item), then one run per thread whose prompt is
 * the texts separated by a blank line. `userMessage` is the last appended line
 * so startTurn does not duplicate it; `excludeIds` is every drained line
 * so transcript-replay adapters do not also see earlier queued texts.
 * Entries leave the map BEFORE running so a settle racing another settle
 * can never fire the same queue twice. */
export function drainSteeredMessages(
  store: SteerStore,
  run: (
    botId: string,
    threadId: string,
    prompt: string,
    userMessage: Message,
    excludeIds: string[],
    unattended: boolean,
  ) => void | Promise<void>,
  isBlocked?: (botId: string, threadId: string) => boolean,
): void {
  // deleting only the entry being visited is safe under Map iteration
  for (const [threadId, entry] of queues) {
    const bot = store.projectBotForTask
      ? store.projectBotForTask(entry.botId, threadId)
      : store.bot(entry.botId);
    if (!bot) {
      // the bot or task was deleted while messages waited
      settleChatFollowups(entry.items.map((item) => item.messageId), "cancelled");
      queues.delete(threadId);
      changed();
      continue;
    }
    if (bot.busy || isBlocked?.(entry.botId, threadId)) continue;
    // committed to draining: the entry leaves the map before anything runs,
    // so a settle racing another settle can never fire the same queue twice
    const ids = entry.items.map((item) => item.messageId);
    settleChatFollowups(ids, "dispatching");
    queues.delete(threadId);
    changed();
    const appended: Message[] = [];
    for (const item of entry.items) {
      // queueId is the pending-chip identity from the 202; append still
      // assigns a fresh transcript id so replay/exclude keep using message.id.
      appended.push(
        store.appendMessage(threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          sendId: item.sendId,
          queueId: item.messageId,
          peerAsk: item.peerAsk,
          sender: item.sender,
        }),
      );
    }
    const last = appended.at(-1);
    if (!last) continue;
    // Keep each queued message on its own Markdown block boundary. A single
    // newline can merge a trailing standalone attachment tag with the next
    // message into one HTML block, which makes that attachment stop being a
    // native image when the combined follow-up is dispatched.
    const prompt = entry.items.map((item) => item.prompt).join("\n\n");
    const running = run(
      entry.botId,
      threadId,
      prompt,
      last,
      appended.map((message) => message.id),
      // one unattended line makes the whole drained turn unattended: a
      // person's words in the same queue cannot re-attend a bot's own
      entry.items.some((item) => item.unattended === true),
    );
    void Promise.resolve(running).then(
      () => settleChatFollowups(ids, null),
      () => settleChatFollowups(ids, "interrupted"),
    ).catch((error) => console.warn("steer-queue: could not settle durable follow-up", error));
  }
}

/** Find the receipt for a retry whose message is still waiting to drain. */
export function queuedSteeredMessage(
  botId: string,
  threadId: string,
  sendId: string,
): { id: string; text: string; replyToId?: string; reason?: "capacity" } | null {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId) return null;
  const item = entry.items.find((candidate) => candidate.sendId === sendId);
  return item ? { id: item.messageId, text: item.text, replyToId: item.replyToId, ...(item.reason ? { reason: item.reason } : {}) } : null;
}

/** Drop one waiting send owned by this bot so it never drains. The queue id
 * is stable even if the bot switches away from the task while the request is
 * in flight. Returns false when it was already drained, belongs to another
 * bot, or dispatch has already started. */
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

/** Atomically lift a thread's whole queue out of the map for a live steer.
 * The entry leaves first so a settle that starts draining while the adapter
 * is still thinking can never also dispatch the same words as a follow-up
 * turn. The caller must either restore the held queue or settle its rows. */
export function holdSteeredQueue(botId: string, threadId: string, queueId: string): HeldSteerQueue | null {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId || !entry.items.some((item) => item.messageId === queueId)) return null;
  queues.delete(threadId);
  changed();
  return { botId, threadId, items: entry.items };
}

/** Put a held queue back after the steer was refused. Words queued while the
 * hold was open keep their place behind the restored items. */
export function restoreHeldSteeredQueue(held: HeldSteerQueue): void {
  const existing = queues.get(held.threadId);
  if (existing && existing.botId !== held.botId) throw new Error("queued task belongs to another bot");
  queues.set(held.threadId, {
    botId: held.botId,
    items: existing ? [...held.items, ...existing.items] : held.items,
  });
  changed();
}

/** Mark a held queue's durable rows delivered: the words were folded into the
 * running turn, so a restart must not replay them as a fresh follow-up. */
export function settleHeldSteeredQueue(held: HeldSteerQueue): void {
  settleChatFollowups(held.items.map((item) => item.messageId), null);
}

/** Test helper: how many messages remain queued for a thread. */
export function _queuedCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}
