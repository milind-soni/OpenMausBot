// Whether two requests to the same bot ask the same thing: the same words in the same order, whatever their case,
// ordinary sentence punctuation or spacing, as when two teammates pass on one question in the person's words. Requests that differ by
// a symbol or any word (an amount, a date, "not", "cost" for "take") are two requests, however alike they read: answering one
// with the other's answer would be wrong, while answering both only costs a second turn. Only a long enough request
// counts: a short "any update?" from two conversations means two things.

/** At least this many characters of words, once case, punctuation and spacing are set aside. */
export const SAME_REQUEST_MIN_CHARS = 40;

/** Symbols and punctuation next to numbers can change the requested amount or comparison. */
const words = (text: string) => text.toLowerCase()
  .replace(/(?<![\p{N}\p{Sc}])[^\p{L}\p{N}\p{S}\s%](?![\p{N}\p{Sc}])/gu, " ")
  .replace(/\s+/g, " ").trim();

export function sameRequest(a: string, b: string): boolean {
  const left = words(a);
  return left.length >= SAME_REQUEST_MIN_CHARS && left === words(b);
}
