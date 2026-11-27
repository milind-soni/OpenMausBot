// Threads whose running turn the harness started for a teammate or its own upkeep, not for a person's message.
// Rewritten by every dispatch, so a peer turn that dies before it starts never silences the person's next turn.
const internalTurnThreads = new Set<string>();

export function markInternalTurn(threadId: string): void {
  internalTurnThreads.add(threadId);
}

export function clearInternalTurn(threadId: string): void {
  internalTurnThreads.delete(threadId);
}

export function isInternalTurn(threadId: string): boolean {
  return internalTurnThreads.has(threadId);
}
