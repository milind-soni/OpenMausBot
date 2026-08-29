// Queue-and-steer for busy 1:1 bots.
//
// A message sent to a bot mid-turn used to bounce with a 409. Now it waits
// here until the bot settles, then lands in the thread and runs as ONE
// follow-up turn whose prompt is the queued texts joined with newlines.
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
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

interface QueueEntry {
  /** Kept beside the threadId because the settle that frees the bot can
   * happen on a DIFFERENT thread (a room turn) — drain matches on "this
   * queue's bot is idle now", which needs the bot, not the settling thread. */
  botId: string;
  items: Array<{ messageId: string; text: string; prompt: string; replyToId?: string; sendId?: string }>;
}

const queues = new Map<string, QueueEntry>(); // threadId → waiting sends

export interface QueuedSteer {
  id: string;
}

/** Hold a mid-turn send off the transcript until drain. */
export function queueSteeredMessage(
  botId: string,
  threadId: string,
  text: string,
  options: { prompt?: string; replyToId?: string; sendId?: string } = {},
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
  });
  queues.set(threadId, entry);
  return { id };
}

/** Drain every queue whose bot is idle: append the held lines (leaf is now
 * the finished turn's last item), then one run per thread whose prompt is
 * the texts joined with newlines. `userMessage` is the last appended line
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
  ) => void | Promise<void>,
): void {
  // deleting only the entry being visited is safe under Map iteration
  for (const [threadId, entry] of queues) {
    const bot = store.bot(entry.botId);
    if (!bot) {
      // the bot was deleted while messages waited — nothing left to steer
      queues.delete(threadId);
      continue;
    }
    if (bot.busy) continue; // still working — the next settle tries again
    // committed to draining: the entry leaves the map before anything runs,
    // so a settle racing another settle can never fire the same queue twice
    queues.delete(threadId);
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
    const prompt = entry.items.map((item) => item.prompt).join("\n");
    void run(
      entry.botId,
      threadId,
      prompt,
      last,
      appended.map((message) => message.id),
    );
  }
}

/** Find the receipt for a retry whose message is still waiting to drain. */
export function queuedSteeredMessage(
  botId: string,
  threadId: string,
  sendId: string,
): { id: string; text: string; replyToId?: string } | null {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId) return null;
  const item = entry.items.find((candidate) => candidate.sendId === sendId);
  return item ? { id: item.messageId, text: item.text, replyToId: item.replyToId } : null;
}

/** Drop one waiting send owned by this bot so it never drains. The queue id
 * is stable even if the bot switches away from the task while the request is
 * in flight. Returns false when it was already drained, belongs to another
 * bot, or a restart lost the in-memory auto-run intent. */
export function cancelSteeredMessage(botId: string, messageId: string): boolean {
  for (const [threadId, entry] of queues) {
    if (entry.botId !== botId) continue;
    const items = entry.items.filter((item) => item.messageId !== messageId);
    if (items.length === entry.items.length) continue;
    if (items.length === 0) queues.delete(threadId);
    else queues.set(threadId, { botId: entry.botId, items });
    return true;
  }
  return false;
}

/** Test helper: how many messages remain queued for a thread. */
export function _queuedCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}
