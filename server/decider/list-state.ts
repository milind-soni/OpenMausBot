// Clipping for the per-entry jobs' state (memory recall, skill pick): each
// entry on one line within a character cap, and the whole list within a
// byte budget, so a request always fits Cloud Pro's relay caps (relay.ts)
// whatever the text is. A CJK note is three bytes a character and a quote
// doubles when escaped, so characters alone are not enough.
import { RELAY_MAX_STATE_BYTES } from "./relay.ts";

/** Room left for JSON punctuation around the state's keys. */
const STATE_BUDGET_BYTES = RELAY_MAX_STATE_BYTES - 1_000;
/** Below this an entry says nothing; the budget is never that tight. */
const MIN_ENTRY_CHARS = 40;

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** One line, runaway whitespace folded, at most `max` characters. */
export function flatClip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Every entry flat and within `maxChars`; while the list is over the byte
 * budget left beside `rest` (the state's other keys), the per-entry cap
 * shrinks, so every entry keeps its place and its opening words. */
export function clipList(entries: readonly string[], maxChars: number, rest: unknown): string[] {
  const budget = STATE_BUDGET_BYTES - jsonBytes(rest);
  let cap = maxChars;
  let list = entries.map((entry) => flatClip(entry, cap));
  while (cap > MIN_ENTRY_CHARS && jsonBytes(list) > budget) {
    cap = Math.max(MIN_ENTRY_CHARS, Math.floor(cap * 0.75));
    list = entries.map((entry) => flatClip(entry, cap));
  }
  return list;
}
