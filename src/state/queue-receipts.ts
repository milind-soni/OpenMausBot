// Queue receipt reconciliation, extracted verbatim from the reducer: a
// bounded tombstone window for consumed queueIds plus snapshot-driven
// restoration of direct-bot queues. Pure state math; no React, no I/O.

import type { Message } from "./model";
import type { AppState } from "./reducer";

const MAX_CONSUMED_QUEUE_IDS = 64;

export function rememberConsumedQueueId(
  consumed: AppState["consumedQueueIds"],
  queueId: string,
): AppState["consumedQueueIds"] {
  const next = { ...consumed, [queueId]: true as const };
  const overflow = Object.keys(next).length - MAX_CONSUMED_QUEUE_IDS;
  if (overflow > 0) {
    for (const id of Object.keys(next).slice(0, overflow)) delete next[id];
  }
  return next;
}

interface QueueReceiptSnapshot {
  messages?: Message[];
}

/** A replacement snapshot can contain the canonical user line after this
 * window missed its queue-drain frame. Remove any matching chip and retain a
 * short tombstone so a slower POST continuation cannot add the chip back. */
export function reconcileSnapshotQueues(
  state: AppState,
  conversations: QueueReceiptSnapshot[],
): AppState {
  const landed: Array<{ queueId: string; at: number }> = [];
  for (const conversation of conversations) {
    for (const message of conversation.messages ?? []) {
      if (message.queueId) landed.push({ queueId: message.queueId, at: message.at });
    }
  }
  if (landed.length === 0) return state;

  const landedIds = new Set(landed.map((entry) => entry.queueId));
  const pendingQueued: AppState["pendingQueued"] = {};
  for (const [threadId, entries] of Object.entries(state.pendingQueued)) {
    const waiting = entries.filter((entry) => !landedIds.has(entry.queueId));
    if (waiting.length > 0) pendingQueued[threadId] = waiting;
  }

  let consumedQueueIds: AppState["consumedQueueIds"] = {};
  // Preserve the newest receipts when a large historical snapshot contains
  // more than the bounded tombstone window.
  landed.sort((left, right) => left.at - right.at);
  for (const entry of landed) {
    consumedQueueIds = rememberConsumedQueueId(consumedQueueIds, entry.queueId);
  }
  // Live drain/cancel receipts are newer than loaded transcript history.
  // Re-reading an old transcript must not evict protection for a late POST.
  for (const queueId of Object.keys(state.consumedQueueIds)) {
    consumedQueueIds = rememberConsumedQueueId(consumedQueueIds, queueId);
  }
  return { ...state, pendingQueued, consumedQueueIds };
}

/** Direct-bot queues are server-owned. Restore them on reload, keeping the
 * separate group queue untouched. Remember removals so a late send response
 * cannot resurrect a message another window already cancelled or drained. */
export function replaceBotQueues(state: AppState, queues: AppState["pendingQueued"]): AppState {
  const groupThreads = new Set(state.groups.flatMap((group) => [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]));
  const liveIds = new Set(Object.values(queues).flatMap((entries) => entries.map((entry) => entry.queueId)));
  const pendingQueued = { ...queues };
  let consumedQueueIds = state.consumedQueueIds;
  for (const [threadId, entries] of Object.entries(state.pendingQueued)) {
    if (groupThreads.has(threadId)) pendingQueued[threadId] = entries;
    else for (const entry of entries) {
      if (!liveIds.has(entry.queueId)) consumedQueueIds = rememberConsumedQueueId(consumedQueueIds, entry.queueId);
    }
  }
  return { ...state, pendingQueued, consumedQueueIds };
}
