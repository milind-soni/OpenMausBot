/** Canonical text for deterministic duplicate/no-change checks. */
export function normalizeTurnText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/**
 * Returns true only when two user payloads are byte-for-byte equivalent after
 * Unicode normalization and whitespace folding. It deliberately does not
 * compare case, punctuation, or semantic meaning: those can change intent.
 */
export function isDeterministicNoChange(previous: string | null | undefined, next: string): boolean {
  return previous !== null && previous !== undefined && normalizeTurnText(previous) === normalizeTurnText(next);
}
