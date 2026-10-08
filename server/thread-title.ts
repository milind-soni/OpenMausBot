// What a generated thread title is asked from.
//
// A fresh thread is named from its first message. "Regenerate title" (#1858)
// names it again from the conversation as it is now: the newest user and bot
// lines, never tool output, cards or screen frames, and bounded so the
// one-shot stays as cheap as the first-message one. A finished Live call is
// named from the requests spoken on it: the user lines that carry its id.
import { redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";

/** The most text either kind of title one-shot ever sees. */
export const TITLE_INPUT_MAX_CHARS = 1_500;
const EXCERPT_MAX_MESSAGES = 12;
const EXCERPT_LINE_MAX_CHARS = 300;
const ATTACHMENT_TAG = /<attached-(?:image|file)\b[^>]*\/>/g;

export type ThreadTitleSource = "first-message" | "conversation" | "call";

/** What each source asks for, and how it labels the text that follows. */
const TITLE_PROMPT: Record<ThreadTitleSource, { ask: string; label: string }> = {
  "first-message": { ask: "Name the conversation that begins with the message below.", label: "Message:" },
  conversation: { ask: "Name the conversation below by what it is about now.", label: "Conversation:" },
  call: { ask: "Name the voice call below by what was asked on it.", label: "Requests:" },
};

export function threadTitlePrompt(text: string, source: ThreadTitleSource = "first-message"): string {
  const { ask, label } = TITLE_PROMPT[source];
  return [
    ask,
    "Reply with only a short title: 3 to 6 words, plain text, no quotes, no trailing period.",
    label,
    text.trim().slice(0, TITLE_INPUT_MAX_CHARS),
  ].join("\n");
}

/** What goes into a title one-shot's input, one message at a time. */
interface ExcerptCandidate {
  /** a prefix for the line ("User", "Bot"); none for a bare line */
  label?: string;
  text: string;
}

/** The one place a title one-shot's input is built: the text of each
 * candidate, in the order given, one line each, until the next line would
 * pass the input cap or `maxLines` are taken. Attachment markup and secrets
 * are scrubbed before anything leaves this machine, whitespace is collapsed
 * and each line is clipped. Lazy, so a long thread costs no more to read
 * than a short one. */
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

/** The newest user and bot text lines, oldest first, one per line and each
 * clipped, until the next line would pass the input cap. Attachment markup
 * and secrets are scrubbed (excerptLines). Empty when the thread has nothing
 * a title could be drawn from. */
export function titleConversationExcerpt(messages: readonly Message[]): string {
  function* newestFirst(): Generator<ExcerptCandidate> {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      // peer asides and still-queued lines are not the conversation yet
      if (message.kind !== "text" || !message.text || message.aside || message.queued) continue;
      yield { label: message.role === "user" ? "User" : "Bot", text: message.text };
    }
  }
  return excerptLines(newestFirst(), EXCERPT_MAX_MESSAGES).reverse().join("\n");
}

/** The requests a person spoke on one Live call, oldest first, one per line
 * and each clipped, until the next would pass the input cap: the user lines
 * carrying that call's id. Never the bot's answers, a typed line, another
 * call's words or anything the voice said (none of those carry the id).
 * Attachment markup and secrets are scrubbed (excerptLines). Empty when
 * nothing was asked. */
export function callTitleExcerpt(messages: readonly Message[], callId: string): string {
  function* spoken(): Generator<ExcerptCandidate> {
    for (const message of messages) {
      if (message.role === "user" && message.kind === "text" && message.callId === callId && message.text) yield { text: message.text };
    }
  }
  return excerptLines(spoken()).join("\n");
}
