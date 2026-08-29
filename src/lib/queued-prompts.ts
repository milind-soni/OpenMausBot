export interface QueuedPromptEntry {
  queueId: string;
  text: string;
}

export interface QueuedPromptRow {
  id: string;
  text: string;
  discardable: boolean;
}

/** Preserve the queue's order and identity for presentation. A list of
 * prompts is not prose and must never be flattened into one display line. */
export function queuedPromptStack(
  roomQueued: { text: string } | undefined,
  pending: readonly QueuedPromptEntry[],
): QueuedPromptRow[] {
  if (roomQueued) return [{ id: "room", text: roomQueued.text, discardable: true }];
  return pending.map((entry) => ({ id: entry.queueId, text: entry.text, discardable: false }));
}
