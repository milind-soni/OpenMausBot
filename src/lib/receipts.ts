// The harness's receipts about a turn (Phase 0): the work digest written
// after every settled turn, and a compaction record. They are the last rows
// of an idle chat, so anything that reads "the last message" as the reply a
// person sees — the sidebar preview, the mascot's mood — must look past
// them. Kept as one predicate so the two agree.
export function isReceipt(message: { kind: string }): boolean {
  return message.kind === "digest" || message.kind === "compaction";
}

/** The newest message that is not a receipt, or undefined. */
export function lastNonReceipt<T extends { kind: string }>(messages: readonly T[] | undefined): T | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (!isReceipt(messages[i]!)) return messages[i];
  }
  return undefined;
}
