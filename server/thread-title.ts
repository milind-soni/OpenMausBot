import { AUTHORITY } from "./provenance-label.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";
import { toolResultPrefix } from "./tool-results.ts";

export const UNTITLED_TASK = "New task";

const PASTE_WRAPPER_LINE = /^\s*<\/?pasted-text(?:\s+index="\d+")?\s*>\s*$/i;
/** OpenMausBot's own note that opens a delivered line ([From <who> · <what> · <authority>], provenance-label.ts). */
const LEADING_FROM_NOTE = new RegExp(`^\\[From [^\\]\\n]* · [^\\]\\n]* · (?:${Object.values(AUTHORITY).join("|")})(?: — [^\\]\\n]*)?\\]`, "u");

/** A line is named by what it says, not by the note saying who sent it; a line that is only a note gives UNTITLED_TASK. */
export function titleFromMessage(text: string): string {
  const lines = text.trim().replace(LEADING_FROM_NOTE, "").trim().split("\n");
  // A message that opens with a paste is named by the pasted text, not the wrapper the composer puts around it.
  const opensWithPaste = PASTE_WRAPPER_LINE.test(lines[0]!) && /<\/pasted-text>/i.test(text);
  const line = opensWithPaste ? firstPastedLine(lines) : lines[0]!.trim();
  return line.length > 48 ? `${toolResultPrefix(line, 47)}…` : line || UNTITLED_TASK;
}

/** The first non-empty line inside a pasted-text block; attachment tags between blocks are skipped. */
function firstPastedLine(lines: string[]): string {
  let inPaste = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (PASTE_WRAPPER_LINE.test(line)) inPaste = !line.startsWith("</");
    else if (inPaste && line) return line;
  }
  return "";
}

export const TITLE_INPUT_MAX_CHARS = 1_500;
const EXCERPT_MAX_MESSAGES = 12;
const EXCERPT_LINE_MAX_CHARS = 300;
const ATTACHMENT_TAG = /<attached-(?:image|file)\b[^>]*\/>/g;

export type ThreadTitleSource = "first-message" | "conversation" | "call";

const TITLE_PROMPT: Record<ThreadTitleSource, { ask: string; label: string }> = {
  "first-message": { ask: "Name the conversation that begins with the message below.", label: "Message:" },
  conversation: { ask: "Name the conversation below by what it is about now.", label: "Conversation:" },
  call: { ask: "Name the voice call below by what was asked on it.", label: "Requests:" },
};

export function threadTitlePrompt(text: string, source: ThreadTitleSource = "first-message"): string {
  const { ask, label } = TITLE_PROMPT[source];
  return [
    ask,
    "Reply with only a short title in the same language as the user's request. Use a concise phrase of at most 48 characters, in plain text, with no quotes or trailing period.",
    label,
    text.trim().slice(0, TITLE_INPUT_MAX_CHARS),
  ].join("\n");
}

interface ExcerptCandidate {
  label?: string;
  text: string;
}

/** Attachment markup and secrets are scrubbed before anything leaves this machine. */
function excerptLines(candidates: Iterable<ExcerptCandidate>, maxLines = Infinity): string[] {
  const lines: string[] = [];
  let length = 0;
  for (const { label, text } of candidates) {
    const clean = redactSecretsInText(text.replace(ATTACHMENT_TAG, " ")).replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const clipped = clean.length > EXCERPT_LINE_MAX_CHARS ? `${clean.slice(0, EXCERPT_LINE_MAX_CHARS - 1)}…` : clean;
    const line = label ? `${label}: ${clipped}` : clipped;
    if (length + line.length + 1 > TITLE_INPUT_MAX_CHARS) break;
    lines.push(line);
    length += line.length + 1;
    if (lines.length >= maxLines) break;
  }
  return lines;
}

export function titleConversationExcerpt(messages: readonly Message[]): string {
  function* newestFirst(): Generator<ExcerptCandidate> {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.kind !== "text" || !message.text || message.aside || message.queued) continue;
      yield { label: message.role === "user" ? "User" : "Bot", text: message.text };
    }
  }
  return excerptLines(newestFirst(), EXCERPT_MAX_MESSAGES).reverse().join("\n");
}

export function callTitleExcerpt(messages: readonly Message[], callId: string): string {
  function* spoken(): Generator<ExcerptCandidate> {
    for (const message of messages) {
      if (message.role === "user" && message.kind === "text" && message.callId === callId && message.text) yield { text: message.text };
    }
  }
  return excerptLines(spoken()).join("\n");
}
