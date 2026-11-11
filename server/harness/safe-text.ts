// Reply text as it streams gets the same masking as the message saved from it. Each message's words so far are
// cleaned as a whole (harness notes, a room's goal envelope, credentials, and the values the server holds as secrets),
// and only the part that can no longer change goes out: never the word still being written, nor anything from an
// unclosed private key, goal envelope or harness note onward. Every bus listener, the event log included, sees only
// what is safe; the finished text arrives with the message's completion.
import type { RuntimeEvent } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";
import { openPrivateKeyAt } from "../../shared/redact.ts";
import { stripLeakedSystemHarnessMessages } from "../../shared/system-message-guard.ts";
import { GROUP_GOAL_CONTROL_CLOSE, GROUP_GOAL_CONTROL_OPEN, visibleCoordinatorText } from "../group-goal-run.ts";

/** Past this much text since the last settled paragraph, the start of the message is settled at a paragraph break. */
const SETTLE_AFTER = 4096;
/** A break is settled only with this much text after it already cleaned: a secret's value that follows its name. */
const SETTLE_LOOKAHEAD = 512;
/** A message with no break to settle at stops streaming here; its finished text still arrives whole. */
const MAX_WINDOW = 64 * 1024;

const HARNESS_OPEN = /<SYSTEM_(?:MESSAGE|NOTIFICATION)>/gi;
const HARNESS_CLOSE = /<\/SYSTEM_(?:MESSAGE|NOTIFICATION)>/i;
const GOAL_OPEN = new RegExp(GROUP_GOAL_CONTROL_OPEN, "g");
const GOAL_CLOSE = new RegExp(GROUP_GOAL_CONTROL_CLOSE);

/** A finished reply as its saved message holds it: the goal envelope out, credentials and held secrets masked. */
export function savedReplyText(text: string): string {
  return redactSecretsInText(text.includes("openmaus-goal>") ? visibleCoordinatorText(text) : text);
}

/** A runtime event as every client receives it: a reply's finished text masked as its saved message is, and a room
 * reply's words naming the member who speaks them, so the app labels them right even as the speaker changes. */
export function publicReplyEvent(event: RuntimeEvent, speakerId?: string): RuntimeEvent {
  if (event.type === "item.completed" && event.itemType === "assistant_text") return { ...event, text: savedReplyText(event.text) };
  if (event.type === "content.delta" && event.streamKind === "assistant_text" && speakerId) return { ...event, botId: speakerId };
  return event;
}

function cleaned(text: string): string {
  return savedReplyText(stripLeakedSystemHarnessMessages(text));
}

/** `cleaned`, keeping the whitespace around the text that the cleaners trim: the stream's next word follows it. */
function spaced(text: string): string {
  const body = cleaned(text);
  if (!body) return "";
  return `${/^\s*/.exec(text)![0]}${body.trim()}${/\s*$/.exec(text)![0]}`;
}

/** First index of an `open` tag with no `close` after it, or -1. */
function unclosed(text: string, open: RegExp, close: RegExp): number {
  open.lastIndex = 0;
  for (let tag = open.exec(text); tag; tag = open.exec(text)) {
    if (!close.test(text.slice(open.lastIndex))) return tag.index;
  }
  return -1;
}

/** How much of `text` may be cleaned and sent: up to its last whitespace, and short of anything still open. */
export function safeEnd(text: string): number {
  let end = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"), text.lastIndexOf("\t")) + 1;
  const head = text.slice(0, end);
  for (const at of [openPrivateKeyAt(head), unclosed(head, HARNESS_OPEN, HARNESS_CLOSE), unclosed(head, GOAL_OPEN, GOAL_CLOSE)]) {
    if (at >= 0 && at < end) end = at;
  }
  return end;
}

interface Stream {
  itemId: string | undefined;
  raw: string;
  /** `raw` before here is settled: cleaned once into `settled` and never again. */
  base: number;
  settled: string;
  sent: string;
  /** What was sent can no longer be extended consistently; the rest comes with the completion. */
  stopped: boolean;
}

/** One instance per event bus: it sees reply text with its message ids, after the bus merges a burst of deltas. */
export class SafeText {
  private readonly streams = new Map<string, Stream>();

  /** A merged burst of a message's deltas as it may be published: its newly safe text, or null while there is none. */
  delta(event: RuntimeEvent): RuntimeEvent | null {
    if (event.type !== "content.delta" || event.streamKind !== "assistant_text") return event;
    let stream = this.streams.get(event.threadId);
    if (!stream || stream.itemId !== event.itemId) {
      stream = { itemId: event.itemId, raw: "", base: 0, settled: "", sent: "", stopped: false };
      this.streams.set(event.threadId, stream);
    }
    const fresh = this.extend(stream, event.delta);
    return fresh ? { ...event, delta: fresh } : null;
  }

  /** Any other event: a message's completion, a tool's start or a turn's end closes the thread's open message. */
  observe(event: RuntimeEvent): void {
    if (
      (event.type === "item.completed" && event.itemType === "assistant_text") ||
      (event.type === "item.started" && event.itemType === "tool") ||
      event.type === "turn.started" || event.type === "turn.completed" || event.type === "cap.exhausted" ||
      event.type === "session.exited" || (event.type === "runtime.error" && event.terminal === true)
    ) this.streams.delete(event.threadId);
  }

  private extend(stream: Stream, delta: string): string {
    stream.raw += delta;
    if (stream.stopped) return "";
    const window = stream.raw.slice(stream.base);
    const end = safeEnd(window);
    const out = stream.settled + spaced(window.slice(0, end));
    if (!out.startsWith(stream.sent)) {
      stream.stopped = true;
      return "";
    }
    const fresh = out.slice(stream.sent.length);
    stream.sent = out;
    if (end > SETTLE_AFTER) this.settle(stream, window, end, out);
    else if (window.length > MAX_WINDOW) stream.stopped = true;
    return fresh;
  }

  /** Moves the settled start up to a paragraph (or line) break, when cleaning the two sides apart gives what was sent. */
  private settle(stream: Stream, window: string, end: number, out: string): void {
    const before = end - SETTLE_LOOKAHEAD;
    let at = window.lastIndexOf("\n\n", before);
    at = at > 0 ? at + 2 : window.lastIndexOf("\n", before) + 1;
    if (at > 0) {
      const settled = stream.settled + spaced(window.slice(0, at));
      if (out.startsWith(settled)) {
        stream.base += at;
        stream.settled = settled;
        return;
      }
    }
    if (window.length > MAX_WINDOW) stream.stopped = true;
  }
}
