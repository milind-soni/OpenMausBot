// Pure pieces of a Live (GPT-Live) call. With client delegation GPT-Live says
// *that* it wants help, never *what*: `session.delegation.created` carries an id
// and a timeline offset, so the request is rebuilt from the input transcript.

import type { LiveSpokenLine } from "./live-call-wire.ts";

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

/** A pause on the session timeline longer than this starts a new spoken line. */
const SPOKEN_LINE_GAP_MS = 1_000;
const MAX_SPOKEN_LINES = 2_000;
/** Held values said across pauses are looked for over this many characters of the latest lines. */
const SPOKEN_JOIN_WINDOW = 512;

type SpokenLineState = { at: number; text: string; endMs: number };

/** The bot's own words on a call (`session.output_transcript.delta` text), one
 * line per stretch of speech, for the call record. A delta without timing
 * continues the current line. */
export class SpokenLines {
  private lines: SpokenLineState[] = [];
  private readonly scrub: (text: string) => string;

  /** `scrub` masks known values (held one-time codes) in each line as it grows, while they are still known to it.
   * It must only replace exact values: a mask it leaves stays, so a value it forgets later stays masked. */
  constructor(scrub: (text: string) => string = (text) => text) {
    this.scrub = scrub;
  }

  add(text: string, at: number, startMs: number, endMs: number): void {
    if (!text) return;
    const timed = Number.isFinite(startMs) && Number.isFinite(endMs);
    const last = this.lines.at(-1);
    if (last && (!timed || startMs <= last.endMs + SPOKEN_LINE_GAP_MS)) {
      last.text = this.scrub(last.text + text);
      if (timed) last.endMs = Math.max(last.endMs, endMs);
    } else {
      if (this.lines.length >= MAX_SPOKEN_LINES) return;
      this.lines.push({ at, text: this.scrub(text), endMs: timed ? endMs : Number.NEGATIVE_INFINITY });
    }
    this.joinAcrossPauses();
  }

  /** A value said across pauses is split over several lines, none of which holds all of it: when the scrub
   * masks something in the last lines joined, they become one line. Looks back while the earlier lines it has
   * joined are shorter than SPOKEN_JOIN_WINDOW, however long the newest line is, so any held value up to that
   * length is caught. */
  private joinAcrossPauses(): void {
    let joined = this.lines.at(-1)?.text ?? "";
    let earlier = 0;
    for (let start = this.lines.length - 2; start >= 0 && earlier < SPOKEN_JOIN_WINDOW; start--) {
      joined = this.lines[start]!.text + joined;
      earlier += this.lines[start]!.text.length;
      const scrubbed = this.scrub(joined);
      if (scrubbed === joined) continue;
      const merged = this.lines.splice(start);
      this.lines.push({ at: merged[0]!.at, text: scrubbed, endMs: Math.max(...merged.map((line) => line.endMs)) });
      this.joinAcrossPauses();
      return;
    }
  }

  list(): LiveSpokenLine[] {
    return this.lines.map((line) => ({ at: line.at, text: joinFragments([line.text]) })).filter((line) => line.text);
  }
}

/** Transcript deltas are fragments of words, not words: glue them as sent. */
export function joinFragments(fragments: string[]): string {
  return fragments.join("").replace(/\s+/g, " ").trim();
}

export const FULL_ANSWER_IN_CHAT = "The full answer is in the chat.";

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

/** Gemini Live's prebuilt voices (Gemini API docs, "Live API capabilities", voices), with the docs' one-word character.
 * Gemini names them with a capital letter. */
export const GEMINI_LIVE_VOICE_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "Puck", label: "Puck — upbeat (default)" },
  { id: "Charon", label: "Charon — informative" },
  { id: "Kore", label: "Kore — firm" },
  { id: "Fenrir", label: "Fenrir — excitable" },
  { id: "Aoede", label: "Aoede — breezy" },
  { id: "Leda", label: "Leda — youthful" },
  { id: "Orus", label: "Orus — firm" },
  { id: "Zephyr", label: "Zephyr — bright" },
];

export const GEMINI_LIVE_DEFAULT_VOICE = "Puck";

/** A saved Gemini voice when it is one of Gemini's, else the default. */
export function geminiLiveVoice(voice: string | undefined): string {
  return GEMINI_LIVE_VOICE_OPTIONS.find((option) => option.id === voice?.trim())?.id ?? GEMINI_LIVE_DEFAULT_VOICE;
}

/** Whether `voice` is one of the voices a bot can have of its own for Live calls: a GPT-Live or a Gemini Live voice. */
export function isBotLiveVoice(voice: unknown): boolean {
  return [...LIVE_VOICE_OPTIONS, ...GEMINI_LIVE_VOICE_OPTIONS].some((option) => option.id === voice);
}

/** The voice a Live call with a bot speaks in: the bot's own voice when it is one of this provider's, else the app's. */
export function botCallVoice(botVoice: string | undefined, appVoice: string | undefined, gemini: boolean): string | undefined {
  return (gemini ? GEMINI_LIVE_VOICE_OPTIONS : LIVE_VOICE_OPTIONS).some((option) => option.id === botVoice) ? botVoice : appVoice;
}

/** A call's length as a clock: m:ss under an hour ("0:07", "1:42"),
 * h:mm:ss from an hour on ("1:02:05"). Whole seconds; a value that is not a
 * length reads as 0:00. */
export function formatCallDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** A Live call row's text: what a client that does not know kind "call"
 * shows as a plain line ("Call with Ada · 1:42"). */
export function liveCallRowText(botName: string, seconds: number): string {
  return `Call with ${botName} · ${formatCallDuration(seconds)}`;
}
