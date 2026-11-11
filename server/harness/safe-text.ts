// Reply text as it streams gets the same masking as the message saved from it. Each message's words so far are
// cleaned as a whole (harness notes, a room's goal envelope, credentials, and the values the server holds as secrets),
// and only the part that can no longer change goes out: never the word still being written, nor anything from an
// unclosed private key, goal envelope or harness note, or the start of a held value, onward. Thinking text gets the
// same. Every bus listener, the event log included, sees only what is safe; the finished text arrives with the
// message's completion.
import type { RuntimeEvent } from "../contracts.ts";
import { heldSecretPendingAt, redactSecretsInText } from "../redact.ts";
import { openPrivateKeyAt } from "../../shared/redact.ts";
import { heldTailStart } from "../../shared/stream-hold.ts";
import { stripLeakedSystemHarnessMessages } from "../../shared/system-message-guard.ts";
import { GROUP_GOAL_CONTROL_CLOSE, GROUP_GOAL_CONTROL_OPEN, visibleCoordinatorText } from "../group-goal-run.ts";

/** Past this much text since the last settled paragraph, the start of the message is settled at a paragraph break. */
const SETTLE_AFTER = 4096;
/** A break is settled only with this much text after it already cleaned: a secret's value that follows its name. */
const SETTLE_LOOKAHEAD = 512;
/** A message with no break to settle at stops streaming here; its finished text still arrives whole. */
const MAX_WINDOW = 64 * 1024;
/** Open messages kept per thread: a message is let go when it completes, a tool starts or the turn ends. */
const MAX_OPEN = 8;

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

/** How much of `text` may be cleaned and sent: short of the word still being written, of anything still open, and of
 * a held value it may have begun. */
export function safeEnd(text: string): number {
  let end = heldTailStart(text);
  const head = text.slice(0, end);
  for (const at of [openPrivateKeyAt(head), unclosed(head, HARNESS_OPEN, HARNESS_CLOSE), unclosed(head, GOAL_OPEN, GOAL_CLOSE)]) {
    if (at >= 0 && at < end) end = at;
  }
  // What would be sent must not end partway into a held value, even one the text goes on to finish: cut before it,
  // and again if the shorter text then ends partway into another.
  for (let held = heldSecretPendingAt(text.slice(0, end)); held >= 0 && held < end; held = heldSecretPendingAt(text.slice(0, end))) end = held;
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
  /** Each thread's open messages, by stream kind and message id. */
  private readonly streams = new Map<string, Map<string, Stream>>();

  /** A merged burst of a message's (or thinking's) deltas as it may be published: its newly safe text, or null while
   * there is none. */
  delta(event: RuntimeEvent): RuntimeEvent | null {
    if (event.type !== "content.delta") return event;
    let open = this.streams.get(event.threadId);
    if (!open) this.streams.set(event.threadId, (open = new Map()));
    const key = `${event.streamKind}:${event.itemId ?? ""}`;
    let stream = open.get(key);
    if (!stream) {
      stream = { itemId: event.itemId, raw: "", base: 0, settled: "", sent: "", stopped: false };
      open.set(key, stream);
      if (open.size > MAX_OPEN) open.delete(open.keys().next().value!);
    }
    const fresh = this.extend(stream, event.delta);
    return fresh ? { ...event, delta: fresh } : null;
  }

  /** Any other event: a message's completion closes that message; a tool's start or a turn's end closes them all. */
  observe(event: RuntimeEvent): void {
    if (event.type === "item.completed" && event.itemType === "assistant_text") {
      this.streams.get(event.threadId)?.delete(`assistant_text:${event.itemId ?? ""}`);
    } else if (
      (event.type === "item.started" && (event.itemType === "tool" || event.itemType === "reasoning")) ||
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

  /** Moves the settled start up to a paragraph (or line) break, when cleaning the two sides apart gives exactly what
   * was sent: a break inside a note, an envelope or a masked value never settles, as cleaning splits it differently.
   * The text after the break must hold more than whitespace, so a secret's name and value are never cut apart there. */
  private settle(stream: Stream, window: string, end: number, out: string): void {
    const before = end - SETTLE_LOOKAHEAD;
    let at = window.lastIndexOf("\n\n", before);
    at = at > 0 ? at + 2 : window.lastIndexOf("\n", before) + 1;
    const after = window.slice(at, end);
    if (at > 0 && after.trim()) {
      const settled = stream.settled + spaced(window.slice(0, at));
      if (out === settled + spaced(after)) {
        stream.base += at;
        stream.settled = settled;
        return;
      }
    }
    if (window.length > MAX_WINDOW) stream.stopped = true;
  }
}
