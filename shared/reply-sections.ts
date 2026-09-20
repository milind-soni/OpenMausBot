// The shape of a bot reply, decided in one place.
//
// A reply has two audiences. Somebody reading it will scroll through a diff,
// a table, and a list of paths without complaint. Somebody *listening* wants
// the two sentences that say what happened. `server/tts/speech-text.ts`
// already rewrites markdown into something a voice can survive, but a filter
// can only make the wrong text less annoying — it cannot know which half was
// the answer, and on a long reply it reads the whole thing either way.
//
// So the reply carries that decision itself, as a section convention: a lead
// in plain prose a voice can read and a reader takes in at a glance, then
// detail under markdown headings — the diff, the table, the paths — opened on
// purpose. These rules find the boundary.
//
// They also have to hold up on text that never adopted the convention,
// because every message already in a transcript is such a text: a reply with
// no headings keeps its whole body for the reader and gets its first
// paragraph for the voice, which is the best guess available and much better
// than reading a file list aloud.
//
// One more thing arrives in real transcripts: a model that wrote its tool
// call as reply text — `{ "action": "press", "keys": ["win", "r"] }` — and
// narrated the mechanics ("We need to output tool use calls."). Both belong
// to the tool channel and the activity chips; neither is prose. The leak is
// stripped before sectioning, so neither audience reads it. A reply that is
// nothing but leak keeps its raw text for the reader (it is the only honest
// thing to show) and is marked so the voice stays silent.
//
// Only a payload that owns its line is taken out. One that shares a line with
// prose is left exactly as written, because removing it edits the sentence
// around it: `The policy uses {"action": "click", "x": 1} by default.`
// reads as "The policy uses by default." — and that is the sentence a voice
// then says aloud. A guard that keeps the display clean must never damage it,
// so where a payload cannot be lifted out whole, with its line holding nothing
// else and its sentence intact, it stays, payload and all.
//
// Pure and synchronous, like the spoken register it feeds: it is the piece
// most likely to need tuning against real transcripts.

export interface ReplyParts {
  /** What a voice reads and a reader sees first: the reply's opening — the
   * text before its first heading, or, for a reply that opens with one, that
   * section's body. Empty only when the reply is nothing but a heading. */
  lead: string;
  /** A heading the lead was taken from, without its hashes, for a reply that
   * opened with one. It is the reader's label, not a sentence to say aloud,
   * so it is kept out of `lead`. Absent when the lead precedes every heading. */
  title?: string;
  /** The sections after the lead, headings included. Empty when the reply is
   * only a lead. */
  detail: string;
  /** The heading titles inside `detail`, in order, for a fold row that has to
   * earn its place with what is behind it. */
  titles: string[];
  /** The reply followed the convention (it has a heading). Without one the
   * reader is shown the whole reply — the lead is then just its first
   * paragraph — and only the voice splits. */
  structured: boolean;
  /** Stripping leaked tool payloads and their narration left nothing: the
   * reply was a tool call written as text. The reader is shown the raw text
   * unchanged and the voice says nothing — `lead` is then the raw text and
   * must not be spoken. */
  toolLeakOnly?: boolean;
}

interface Heading {
  /** Index of the heading's first character (its line's start). */
  start: number;
  /** Index just past the heading's text. */
  end: number;
  title: string;
}

/** ATX headings outside fenced code. A `# install deps` line inside a shell
 * snippet is a comment, not a section, so fences are tracked first — one
 * misread fence would fold the reply in the middle of a command. */
function headings(text: string): Heading[] {
  const found: Heading[] = [];
  let fence: string | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const char = marker[1][0];
      // a fence closes only on its own character, so ``` inside a ~~~ block
      // stays code and never reopens anything
      if (!fence) fence = char;
      else if (fence === char) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?\S)[ \t]*$/.exec(line);
    if (heading) found.push({ start, end: start + line.length, title: heading[1] });
  }
  return found;
}

/** Keys a computer action payload uses — the vocab of the computer tools'
 * input schemas (click, press_key, computer_batch items, …). A JSON object
 * whose every key is in this set and that carries an `action` is a tool call
 * written as text, never something to read aloud. */
const ACTION_KEYS = new Set([
  "action", "keys", "key", "text", "x", "y", "button", "double", "direction",
  "clicks", "ms", "url", "element", "coordinate", "duration", "app", "window",
  "observe", "wait", "screenshot",
]);

function looksLikeAction(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 12) return false;
  if (!entries.some(([key, value]) => key === "action" && typeof value === "string")) return false;
  return entries.every(([key, entry]) =>
    ACTION_KEYS.has(key) &&
    (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" ||
      (key === "keys" && Array.isArray(entry) && entry.every((item) => typeof item === "string"))));
}

/** Index of the bracket closing the one opened at `start`, strings aware.
 * -1 when unbalanced (truncated stream — leave the text alone). */
function balancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The mechanics of acting, narrated as if the reader asked for them: a line
 * that says it is emitting tool calls — "We need to output tool use calls."
 * Whole lines matching this are dropped, and a reply that is nothing but such
 * lines is silent.
 *
 * One pattern, deliberately narrow: it names the act of emitting tool calls,
 * which no ordinary sentence does. Two broader ones used to sit beside it —
 * `we need to <verb>` and `now let's <verb>` — and they deleted prose: "We
 * need to send the report to the team before Friday.", "I need to call the
 * vendor about the invoice." and "Then let us call it a day." all matched, so
 * each was removed and, alone in a reply, left the voice with nothing to say.
 * A modal and a verb cannot tell narration from intent — "we need to call the
 * tool library" is a plan, not a leak — so those patterns are gone rather than
 * narrowed. A line that never names tool calls is shown, which is
 * recoverable; deleting a real sentence is not. */
const NARRATION_LINE = [
  /\boutput(?:ting)?\s+(?:the\s+)?tool(?:\s*use)?\s+calls?\b/i,
];

/** Bare (unfenced) JSON tool payloads and narration lines out; fenced code
 * stays — a ```json block is usually a legitimate example, and the reader
 * asked for code there. Returns "" when everything was leak.
 *
 * Removal is line-granular and deliberately conservative: a payload is taken
 * out only when nothing but whitespace shares its line, so the text that
 * survives is exactly the text that was written. A payload inside a sentence
 * is kept — the module header says why showing it beats deleting the words
 * around it. */
export function stripToolLeak(text: string): string {
  const lines = text.split("\n");
  // Per-character fenced marks: the scanner must not eat a payload inside a
  // code block, and a `# comment` inside one is not a heading either.
  const fenced = new Uint8Array(text.length);
  let fence: string | null = null;
  let offset = 0;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const char = marker[1][0];
      if (!fence) fence = char;
      else if (fence === char) fence = null;
    }
    if (fence || marker) fenced.fill(1, offset, offset + line.length);
    offset += line.length + 1;
  }

  let out = "";
  let i = 0;
  while (i < text.length) {
    if (fenced[i]) { out += text[i]; i++; continue; }
    const char = text[i];
    if (char === "{" || (char === "[" && text[i + 1] === "{")) {
      const end = balancedEnd(text, i);
      if (end > i) {
        let leak = false;
        try {
          const parsed: unknown = JSON.parse(text.slice(i, end + 1));
          leak = Array.isArray(parsed)
            ? parsed.length > 0 && parsed.every(looksLikeAction)
            : looksLikeAction(parsed);
        } catch {
          leak = false;
        }
        // Line-granular, and the whole point of the guard: a payload is only
        // removable when its line holds nothing else. Inside a sentence, the
        // deletion would edit the prose — `The policy uses {...} by default.`
        // losing its payload reads as "The policy uses by default." — so the
        // sentence is left intact, payload and all. Where removal cannot be
        // clean, it is not done: a guard that protects the display must never
        // be the thing that damages it.
        const lineStart = text.lastIndexOf("\n", i - 1) + 1;
        const lineEnd = text.indexOf("\n", end + 1);
        const before = text.slice(lineStart, i);
        const after = text.slice(end + 1, lineEnd < 0 ? text.length : lineEnd);
        if (leak && before.trim() === "" && after.trim() === "") {
          // the payload owns its line: drop the indentation already emitted
          // for it, then the line ending after it, so no whitespace-only line
          // is left behind
          out = out.slice(0, out.length - before.length);
          i = end + 1;
          while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
          if (text[i] === "\n") i++;
          continue;
        }
      }
    }
    out += char;
    i++;
  }

  const kept = out
    .split("\n")
    .filter((line) => !NARRATION_LINE.some((rule) => rule.test(line)))
    .join("\n");
  return kept.replace(/\n{3,}/g, "\n\n").trim();
}

export function splitReply(input: string): ReplyParts {
  // Normalized, not rewritten: offsets below index into this string.
  const raw = String(input ?? "").replace(/\r\n?/g, "\n").trim();
  if (!raw) return { lead: "", detail: "", titles: [], structured: false };

  const text = stripToolLeak(raw);
  if (!text) return { lead: raw, detail: "", titles: [], structured: false, toolLeakOnly: true };

  const sections = headings(text);
  if (sections.length === 0) {
    const gap = text.search(/\n[ \t]*\n/);
    if (gap < 0) return { lead: text, detail: "", titles: [], structured: false };
    return {
      lead: text.slice(0, gap).trim(),
      detail: text.slice(gap).trim(),
      titles: [],
      structured: false,
    };
  }

  const [first, second] = sections;
  if (first.start > 0) {
    // prose first, then headings: the shape the convention asks for
    return {
      lead: text.slice(0, first.start).trim(),
      detail: text.slice(first.start).trim(),
      titles: sections.map((section) => section.title),
      structured: true,
    };
  }

  // The reply opens with a heading, so the lead is that section's body and
  // the detail starts at the next one.
  const detailStart = second ? second.start : text.length;
  return {
    lead: text.slice(first.end, detailStart).trim(),
    title: first.title,
    detail: second ? text.slice(second.start).trim() : "",
    titles: sections.slice(1).map((section) => section.title),
    structured: true,
  };
}

/**
 * The half of a reply a voice reads.
 *
 * One owner, because this is a decision rather than a detail: the harness route
 * (`/api/tts/prepare`) and the renderer's own speech engine both need the same
 * answer, and they cannot see each other — nothing in `src/` may import
 * `server/`, so the only home they share is here, beside the split that
 * produces it. Two copies of a rule like this drift the moment one is touched,
 * which is exactly what happened when it lived in both shapes at once.
 *
 * A reply written to the section convention says what happened in its lead and
 * keeps the diff, the paths, and the tables under headings for the eye, so the
 * voice gets the lead. A reply that never adopted the convention falls back to
 * its whole text, exactly as it was spoken before a convention existed. A reply
 * that is nothing but a leaked tool payload is not prose at all, so it is
 * silent — the reader still sees it raw, and `toolLeakOnly` is how they know.
 */
export function spokenReply(input: string): string {
  const parts = splitReply(input);
  return parts.toolLeakOnly ? "" : (parts.lead || input).trim();
}
