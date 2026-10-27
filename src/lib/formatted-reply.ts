const BLOCK_MARKDOWN = [
  /^ {0,3}(?:[-*+]|\d{1,3}[.)]) \S/m,
  /^ {0,3}#{1,6} \S/m,
  /^ {0,3}(?:```|~~~)/m,
  /^ {0,3}> ?\S/m,
  /^ {0,3}\|? *:?-{3,}:? *\|/m,
];

/** A reply with block markdown (a list, heading, code, quote or table) reads as a document, not a chat line. */
export function isFormattedReply(text: string): boolean {
  return BLOCK_MARKDOWN.some((pattern) => pattern.test(text));
}
