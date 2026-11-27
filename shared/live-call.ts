import { FULL_ANSWER_IN_CHAT } from "../packages/phone-protocol/src/live-call.ts";

export * from "../packages/phone-protocol/src/live-call.ts";

/** GPT-Live caps each append at 500 tokens. A 500 UTF-8 byte budget is
 * conservative even for emoji/CJK, unlike a prose-only character estimate.
 * Byte-level tokenization cannot produce more tokens than input bytes. */
const APPEND_BYTE_LIMIT = 500;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** Standard UTF-8 accounting; stop at a complete code point, not a surrogate. */
function bytePrefix(text: string, budget: number): string {
  return new TextDecoder().decode(encoder.encode(text).subarray(0, budget), { stream: true });
}
const MAX_SPOKEN_CHUNKS = 3;

/** Group speakable utterances (from /api/tts/prepare) into appends. Long
 * answers are cut at a sentence boundary with a pointer to the chat, because
 * a voice reading four minutes of a report is not a conversation. */
export function commentaryChunks(utterances: string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  let truncated = false;
  for (const raw of utterances) {
    const utterance = raw.replace(/\s+/g, " ").trim();
    if (!utterance) continue;
    const pieces = bytes(utterance) > APPEND_BYTE_LIMIT ? splitLong(utterance) : [utterance];
    for (const piece of pieces) {
      if (current && bytes(current) + 1 + bytes(piece) > APPEND_BYTE_LIMIT) {
        chunks.push(current);
        current = "";
      }
      if (chunks.length >= MAX_SPOKEN_CHUNKS) {
        truncated = true;
        break;
      }
      current = current ? `${current} ${piece}` : piece;
    }
    if (truncated) break;
  }
  if (current && chunks.length < MAX_SPOKEN_CHUNKS) chunks.push(current);
  else if (current) truncated = true;
  if (truncated && chunks.length) {
    const last = chunks[chunks.length - 1];
    chunks[chunks.length - 1] = bytes(last) + 1 + bytes(FULL_ANSWER_IN_CHAT) <= APPEND_BYTE_LIMIT
      ? `${last} ${FULL_ANSWER_IN_CHAT}`
      : `${bytePrefix(last, APPEND_BYTE_LIMIT - bytes(FULL_ANSWER_IN_CHAT) - 1).replace(/\s+\S*$/, "")} ${FULL_ANSWER_IN_CHAT}`;
  }
  return chunks;
}

function splitLong(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (bytes(rest) > APPEND_BYTE_LIMIT) {
    const window = bytePrefix(rest, APPEND_BYTE_LIMIT);
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    const space = window.lastIndexOf(" ");
    const cut = sentence > window.length / 2 ? sentence + 1 : space > 0 ? space : window.length;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Keep appended content inside the per-append limit. */
export function clampAppend(content: string): string {
  const text = content.replace(/\s+/g, " ").trim();
  return bytes(text) <= APPEND_BYTE_LIMIT ? text : `${bytePrefix(text, APPEND_BYTE_LIMIT - bytes("…")).replace(/\s+\S*$/, "")}…`;
}
