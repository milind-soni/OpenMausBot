/** Byte length as the server counts it: the soul cap is a UTF-8 budget. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The blurb a long description collapses to when it moves into SOUL.md:
 * the first sentence, or the first line, capped. */
export function firstSentence(text: string, max = 200): string {
  const line = text.trim().split("\n")[0] ?? "";
  const match = line.match(/^.*?[.!?](?=\s|$)/);
  const sentence = (match ? match[0] : line).trim();
  return sentence.slice(0, max);
}

/** The over-cap gate for the SOUL.md editor: a draft within the byte limit
 * becomes a patch to send; a draft over it stays local (never sent, so the
 * counter is the only thing that turns red). */
export function soulPatchFor(value: string, limit: number): { soul: string } | null {
  return utf8Bytes(value) > limit ? null : { soul: value };
}
