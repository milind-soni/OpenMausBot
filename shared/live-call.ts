// Pure pieces of a Live (GPT-Live) call, kept out of the component so they
// can be tested without WebRTC.
//
// With client delegation GPT-Live says *that* it wants help, never *what*:
// `session.delegation.created` carries an id and a timeline offset, and the
// request has to be rebuilt from the input transcript. That reconstruction,
// and the shaping of the bot's answer into the 500-token appends GPT-Live
// accepts, live here.

export interface TranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
}

/** Collects `session.input_transcript.delta` fragments on the session
 * timeline. Fragments are appended in delivery order, as the API asks. */
export class LiveTranscript {
  private input: TranscriptSegment[] = [];
  /** when the voice itself was speaking, on the same timeline */
  private output: Array<{ startMs: number; endMs: number }> = [];
  private cutoffMs = -1;

  addInput(text: string, startMs: number, endMs: number): void {
    if (!text) return;
    this.input.push({ text, startMs: Number.isFinite(startMs) ? startMs : 0, endMs: Number.isFinite(endMs) ? endMs : 0 });
    // keep memory bounded on long calls: only the unconsumed tail matters
    if (this.input.length > 2_000) this.input = this.input.filter((segment) => segment.startMs > this.cutoffMs);
  }

  /** A stretch of the voice's own speech (a `session.output_transcript.delta`
   * with its timing). Input heard during it may be the voice itself, picked
   * up again by the microphone of a phone on speaker. Deltas without timing
   * are ignored. */
  addOutput(startMs: number, endMs: number): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return;
    const last = this.output.at(-1);
    if (last && startMs <= last.endMs) last.endMs = Math.max(last.endMs, endMs);
    else this.output.push({ startMs, endMs });
    if (this.output.length > 500) this.output.splice(0, this.output.length - 500);
  }

  /** The words spoken since the previous request, up to a little past the
   * delegation point (transcription can trail the delegation event, and the
   * person may finish the sentence that triggered it). Consumes them, so the
   * next request starts after this one. */
  takeRequest(offsetMs: number, graceMs = 1_500): string {
    return this.takeRequestParts(offsetMs, graceMs).text;
  }

  /** takeRequest, plus the same words without those heard while the voice
   * spoke (`withoutEcho`), for reading a spoken yes/no. Consumes all of them. */
  takeRequestParts(offsetMs: number, graceMs = 1_500): { text: string; withoutEcho: string } {
    const until = offsetMs + graceMs;
    const taken = this.input.filter((segment) => segment.startMs > this.cutoffMs && segment.startMs <= until);
    if (!taken.length) return { text: "", withoutEcho: "" };
    this.cutoffMs = Math.max(this.cutoffMs, ...taken.map((segment) => segment.startMs));
    return {
      text: joinFragments(taken.map((segment) => segment.text)),
      withoutEcho: joinFragments(taken.filter((segment) => !this.echoed(segment)).map((segment) => segment.text)),
    };
  }

  /** Everything heard since the last taken request, without consuming it —
   * used to read a spoken yes/no while a permission question is open.
   * `skipEcho` leaves out what was heard while the voice itself spoke. */
  pending(options: { skipEcho?: boolean } = {}): string {
    return joinFragments(this.input
      .filter((segment) => segment.startMs > this.cutoffMs && !(options.skipEcho && this.echoed(segment)))
      .map((segment) => segment.text));
  }

  private echoed(segment: TranscriptSegment): boolean {
    return this.output.some((span) => segment.startMs < span.endMs && segment.endMs > span.startMs);
  }

  /** Mark everything heard so far as handled (e.g. after a spoken decision). */
  consumeAll(): void {
    for (const segment of this.input) this.cutoffMs = Math.max(this.cutoffMs, segment.startMs);
  }
}

/** Transcript deltas are fragments of words, not words: glue them as sent. */
export function joinFragments(fragments: string[]): string {
  return fragments.join("").replace(/\s+/g, " ").trim();
}

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
export const FULL_ANSWER_IN_CHAT = "The full answer is in the chat.";

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

/** GPT-Live voices from OpenAI's documentation (Managing GPT-Live sessions,
 * "Voice options", and the SDK's BuiltInVoice list), with the regional
 * notes the docs give for the additional ones. */
export const LIVE_VOICE_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "marin", label: "Marin (default)" },
  { id: "cedar", label: "Cedar" },
  { id: "alloy", label: "Alloy" },
  { id: "ash", label: "Ash" },
  { id: "ballad", label: "Ballad" },
  { id: "coral", label: "Coral" },
  { id: "echo", label: "Echo" },
  { id: "sage", label: "Sage" },
  { id: "shimmer", label: "Shimmer" },
  { id: "verse", label: "Verse" },
  { id: "gleam", label: "Gleam — North American, feminine" },
  { id: "meridian", label: "Meridian — North American, masculine" },
  { id: "quartz", label: "Quartz — Australian, feminine" },
  { id: "ripple", label: "Ripple — Australian, masculine" },
  { id: "vesper", label: "Vesper — British, masculine" },
  { id: "willow", label: "Willow — Irish, feminine" },
  { id: "stone", label: "Stone — Irish, masculine" },
  { id: "delta", label: "Delta — Southern U.S., feminine" },
  { id: "cinder", label: "Cinder — Southern U.S., masculine" },
  { id: "beacon", label: "Beacon — Filipino, masculine" },
  { id: "bossa", label: "Bossa — Brazilian Portuguese, feminine" },
  { id: "tempo", label: "Tempo — Brazilian Portuguese, masculine" },
];
