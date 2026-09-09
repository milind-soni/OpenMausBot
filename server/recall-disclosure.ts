// When a bot answers in a room using something it recalled from a private
// thread, the room cannot see that it did. The capability is deliberate —
// #754 gave bots recall precisely so a bot mentioned in a channel can answer
// about work discussed in its DM — so the answer is not to block the
// crossing but to make it visible where it lands.
//
// Disclosure is per (room thread, source thread): a bot that searches three
// times in one turn announces each private thread once, not once per search.
// The ledger is in memory, so a restart re-announces. That is the safe
// direction: a duplicate chip is noise, a missing one is the whole bug.

/** Source threads already announced in a given room thread. */
const announced = new Map<string, Set<string>>();

export interface RecallCrossing {
  /** Source threads this call surfaced that the room has not been told about. */
  threadIds: string[];
  /** How many recalled messages came from them. */
  count: number;
}

/**
 * The crossings worth announcing in `roomThreadId`, marking them announced.
 * `sources` is one entry per recalled message, in hit order.
 */
export function claimRecallCrossings(roomThreadId: string, sources: readonly string[]): RecallCrossing {
  const seen = announced.get(roomThreadId) ?? new Set<string>();
  const threadIds: string[] = [];
  let count = 0;
  for (const threadId of sources) {
    if (seen.has(threadId)) continue;
    if (!threadIds.includes(threadId)) threadIds.push(threadId);
    count += 1;
  }
  if (!threadIds.length) return { threadIds: [], count: 0 };
  for (const threadId of threadIds) seen.add(threadId);
  announced.set(roomThreadId, seen);
  return { threadIds, count };
}

/** The chip's text. Says what crossed, not that anything went wrong. */
export function recallCrossingLabel(botName: string, count: number): string {
  return `${botName} recalled ${count} message${count === 1 ? "" : "s"} from its private chat with you`;
}

/** Forget a room's ledger. Used when a room thread is cleared, and by tests. */
export function forgetRecallCrossings(roomThreadId?: string): void {
  if (roomThreadId === undefined) announced.clear();
  else announced.delete(roomThreadId);
}
