// Queue-and-steer for busy 1:1 bots.
//
// A message sent to a bot mid-turn used to bounce with a 409. Now it lands
// in the thread immediately — visible, persisted, marked `queued` — and
// waits here until the bot settles. On settle, every queued message for
// the thread drains into ONE follow-up turn whose prompt is the queued
// texts joined with newlines, so a burst of steering notes costs one turn.
//
// The queue itself is memory-only on purpose: each queued message is
// already an ordinary persisted thread message, so a restart loses only
// the "auto-run on settle" intent, never the words — the same honesty as
// delegations and provider approvals, which also die with the process.
// (The client renders the queued affordance only while the bot is busy, so
// a flag stranded by a restart is invisible rather than a false promise.)
//
// Unlike the delegation drain, an interrupted or failed turn does NOT
// discard this queue: delegations are a bot's fan-out (dropping them on
// Stop is a safety property), but these are the user's own words —
// stop-then-steer (queue a correction, hit Stop, the correction runs) is
// the feature.

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
  items: Array<{ messageId: string; text: string }>;
}

const queues = new Map<string, QueueEntry>(); // threadId → waiting sends

/** Land a message in the busy bot's active thread now; it auto-sends when
 * the turn settles. The `queued` flag is the transcript's "will send when
 * this turn finishes" affordance — drain clears it when consumed. */
export function queueSteeredMessage(store: SteerStore, bot: BotRecord, text: string): Message {
  const threadId = bot.threadId;
  const message = store.appendMessage(threadId, { role: "user", kind: "text", text, queued: true });
  const entry = queues.get(threadId) ?? { botId: bot.id, items: [] };
  entry.items.push({ messageId: message.id, text });
  queues.set(threadId, entry);
  return message;
}

/** Drain every queue whose bot is idle: one run per thread, prompt = the
 * queued texts joined with newlines. `userMessage` is the last queued
 * message so the caller's startTurn appends nothing new — the messages are
 * already in the transcript. Entries are removed BEFORE running so a
 * settle racing another settle can never fire the same queue twice. */
export function drainSteeredMessages(
  store: SteerStore,
  run: (botId: string, threadId: string, prompt: string, userMessage: Message) => void | Promise<void>,
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
    // clear the affordance before dispatch, so the user never sees
    // "queued" on a message the bot is already answering
    let last: Message | null = null;
    for (const item of entry.items) {
      last = store.patchMessage(threadId, item.messageId, { queued: undefined }) ?? last;
    }
    // every queued message gone from the store = the thread itself was
    // deleted out from under the queue; there is nothing to run against
    if (!last) continue;
    const prompt = entry.items.map((item) => item.text).join("\n");
    void run(entry.botId, threadId, prompt, last);
  }
}

/** Test helper: how many messages remain queued for a thread. */
export function _queuedCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}
