// The harness's receipts about a turn (Phase 0): the work digest written
// after every settled turn, and a compaction record. A finished Live call's
// record row is one too: it is appended when the call ends, wherever the
// chat is then, often right after a turn that failed or is still working.
// They are the last rows of an idle chat, so anything that reads "the last
// message" as the reply a person sees — the sidebar preview, the mascot's
// mood, the row Retry belongs to, the working line — must look past them.
// Kept as one predicate so they agree.
export function isReceipt(message: { kind: string }): boolean {
  return message.kind === "digest" || message.kind === "compaction" || message.kind === "call";
}

/** The newest message that is not a receipt, or undefined. */
export function lastNonReceipt<T extends { kind: string }>(messages: readonly T[] | undefined): T | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (!isReceipt(messages[i]!)) return messages[i];
  }
  return undefined;
}
