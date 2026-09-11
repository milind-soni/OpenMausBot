// Queue-and-steer for busy 1:1 bots.
//
// A message sent to a bot mid-turn used to bounce with a 409. Now it waits
// here until the bot settles, then lands in the thread and runs as ONE
// follow-up turn whose prompt is the queued texts separated by a blank line.
//
// The queue is memory-only and is NOT in `messages[]` while the current
// turn is running: appending immediately would make the queued line the
// active leaf, so remaining tool/assistant events of *this* turn would
// hang off a user line the model has not seen. Restart loses the queue
// (same as delegations / approvals). The composer shows a pending chip
// until drain appends the words.
//
// Unlike the delegation drain, an interrupted or failed turn does NOT
// discard this queue: delegations are a bot's fan-out (dropping them on
// Stop is a safety property), but these are the user's own words —
// stop-then-steer (queue a correction, hit Stop, the correction runs) is
// the feature.

import { newId } from "./contracts.ts";
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
  }>;
}

const queues = new Map<string, QueueEntry>(); // threadId → waiting sends
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
  options: { prompt?: string; replyToId?: string; sendId?: string; reason?: "capacity"; unattended?: boolean } = {},
): QueuedSteer {
  const id = newId();
  const entry = queues.get(threadId) ?? { botId, items: [] };
  // A thread cannot legitimately change owners. Refuse to merge unrelated
  // queues even if a corrupt caller reuses a thread id.
  if (entry.botId !== botId) throw new Error("queued task belongs to another bot");
  entry.items.push({
    messageId: id,
    text,
    prompt: options.prompt ?? text,
    replyToId: options.replyToId,
    sendId: options.sendId,
    reason: options.reason,
    unattended: options.unattended,
  });
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
      queues.delete(threadId);
      changed();
      continue;
    }
    if (bot.busy || isBlocked?.(entry.botId, threadId)) continue;
    // committed to draining: the entry leaves the map before anything runs,
    // so a settle racing another settle can never fire the same queue twice
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
    void run(
      entry.botId,
      threadId,
      prompt,
      last,
      appended.map((message) => message.id),
      // one unattended line makes the whole drained turn unattended: a
      // person's words in the same queue cannot re-attend a bot's own
      entry.items.some((item) => item.unattended === true),
    );
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
 * bot, or a restart lost the in-memory auto-run intent. */
export function cancelSteeredMessage(botId: string, messageId: string, expectedThreadId?: string): boolean {
  for (const [threadId, entry] of queues) {
    if (entry.botId !== botId || (expectedThreadId !== undefined && threadId !== expectedThreadId)) continue;
    const items = entry.items.filter((item) => item.messageId !== messageId);
    if (items.length === entry.items.length) continue;
    if (items.length === 0) queues.delete(threadId);
    else queues.set(threadId, { botId: entry.botId, items });
    changed();
    return true;
  }
  return false;
}

/** Test helper: how many messages remain queued for a thread. */
export function _queuedCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}
