// The shape of a bot reply, decided in one place.
//
// A reply has two audiences: somebody reading a transcript, and somebody
// hearing it read aloud. A filter over the finished text cannot tell which
// half was the answer, so the reply carries the decision itself as a section
// convention — a lead in plain prose, then detail under markdown headings,
// opened on purpose. `spokenReply` at the bottom is the half a voice reads.
//
// Text that never adopted the convention still has to work, because every
// message already in a transcript is such a text: with no headings the reader
// keeps the whole reply and the voice gets its first paragraph.
//
// Real transcripts also contain a model that wrote its tool call as reply
// text — `{ "action": "press", "keys": ["win", "r"] }` — and narrated the
// mechanics. Both belong to the tool channel, so they are stripped before
// sectioning. A reply that was nothing but leak keeps its raw text for the
// reader (the only honest thing to show) and is marked so the voice is silent.
//
// Only a payload that owns its line is taken out. One sharing a line with
// prose stays as written, because removing it would edit the sentence around
// it: a guard that keeps the display clean must never be the thing that
// damages it.

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
  /** The reply as the reader should see it when nothing is folded: the text
   * with any leaked payload removed, or the raw text for a reply that was
   * nothing but leak. Derived here so the reader and the voice cannot
   * disagree about what the reply says. */
  display: string;
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

/** Per-character marks for fenced code: a fence's marker lines and every line
 * between them. Both readers below need the same rule, and the rule is subtle
 * — a fence closes only on its own character, so ``` inside a ~~~ block stays
 * code and never reopens anything. */
function fenceMask(text: string): Uint8Array {
  const masked = new Uint8Array(text.length);
  let fence: string | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const char = marker[1][0];
      if (!fence) fence = char;
      else if (fence === char) fence = null;
    }
    if (fence || marker) masked.fill(1, offset, offset + line.length);
    offset += line.length + 1;
  }
  return masked;
}

/** ATX headings outside fenced code. A `# install deps` line inside a shell
 * snippet is a comment, not a section, so one misread fence would fold the
 * reply in the middle of a command. */
function headings(text: string): Heading[] {
  const found: Heading[] = [];
  const fenced = fenceMask(text);
  let offset = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    if (fenced[start]) continue;
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?\S)[ \t]*$/.exec(line);
    if (heading) found.push({ start, end: start + line.length, title: heading[1] });
  }
  return found;
}

/** A JSON object carrying a string `action` is a computer tool call written as
 * text, never something to read aloud. Bounded, so a large configuration blob
 * that happens to own an `action` key is left alone. */
function looksLikeAction(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 12 && entries.some(([key, entry]) => key === "action" && typeof entry === "string");
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
 * that *is* the statement about emitting tool calls, and nothing else.
 *
 * Anchored at both ends deliberately. Merely containing the phrase is not
 * enough: that deleted prose which mentioned it, and deleted lines inside a
 * code block the reader asked for. Earlier versions matched bare
 * `we need to <verb>` / `now let's <verb>` and deleted real sentences ("We
 * need to send the report to the team before Friday.") leaving the voice
 * nothing to say. Showing a stray mechanics line is recoverable; deleting a
 * real sentence is not. */
const TOOL_NARRATION = /^\s*(?:we|i)(?:'ll|'m going to)?(?:\s+(?:need\s+to|must|have\s+to|will|are\s+going\s+to|am\s+going\s+to))?\s+output(?:ting)?\s+(?:the\s+)?tool(?:\s*use)?\s+calls?\b[.!]*\s*$/i;

/** Bare (unfenced) JSON tool payloads and narration lines out; fenced code
 * stays — a ```json block is a legitimate example, and the reader asked for
 * code there. Returns "" when everything was leak. */
function stripToolLeak(text: string): string {
  const fenced = fenceMask(text);
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
        // Line-granular: removable only when nothing else shares the line, so
        // the surviving text is exactly the text that was written.
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
          // a payload that sat between blank lines takes one of them with it,
          // so removing it cannot leave a blank run behind
          if (out.endsWith("\n\n") && text[i] === "\n") i++;
          continue;
        }
      }
    }
    out += char;
    i++;
  }

  // Narration lines, outside fences only: a code sample that quotes the phrase
  // is code, not the model narrating itself. Nothing here rewrites the reply
  // wholesale, which would rewrite the fence with it. The mask is recomputed
  // because whole lines are gone from `out`; fences themselves are untouched.
  const outFenced = fenceMask(out);
  let offset = 0;
  const kept: string[] = [];
  for (const line of out.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    if (outFenced[start] || !TOOL_NARRATION.test(line)) kept.push(line);
  }
  return kept.join("\n").trim();
}

export function splitReply(input: string): ReplyParts {
  // Normalized, not rewritten: offsets below index into this string.
  const raw = String(input ?? "").replace(/\r\n?/g, "\n").trim();
  if (!raw) return { lead: "", detail: "", display: "", titles: [], structured: false };

  const text = stripToolLeak(raw);
  if (!text) return { lead: raw, detail: "", display: raw, titles: [], structured: false, toolLeakOnly: true };

  const sections = headings(text);
  if (sections.length === 0) {
    const gap = text.search(/\n[ \t]*\n/);
    if (gap < 0) return { lead: text, detail: "", display: text, titles: [], structured: false };
    return {
      lead: text.slice(0, gap).trim(),
      detail: text.slice(gap).trim(),
      display: text,
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
      display: text,
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
    display: text,
    titles: sections.slice(1).map((section) => section.title),
    structured: true,
  };
}

/**
 * The half of a reply a voice reads.
 *
 * One owner: the harness route (`/api/tts/prepare`) and the renderer's own
 * speech engine both need this answer and cannot see each other — nothing in
 * `src/` may import `server/` — so it lives beside the split that produces
 * it. A reply written to the convention gets its lead; one that never adopted
 * it falls back to its whole text; one that is nothing but a leaked payload is
 * silent, since there is no prose in it to say. */
export function spokenReply(input: string): string {
  const parts = splitReply(input);
  return parts.toolLeakOnly ? "" : (parts.lead || input).trim();
}
