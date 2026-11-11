// Reply text as it streams gets the same masking as the message saved from it. Each message's words so far are
// cleaned as a whole (harness notes, a room's goal envelope, credentials, and the values the server holds as secrets),
// and only the part that can no longer change goes out: never the word still being written, nor anything from an
// unclosed private key, goal envelope or harness note onward. While the server holds secret values, the last
// characters always wait too, as many as the longest of them (rounded up), whatever they are: what a stream sends
// never depends on how much of a held value the text has begun. Thinking text gets the same. Every bus listener, the
// event log included, sees only what is safe; a reply's finished text arrives with its completion, and the rest of
// a thinking stream when it ends.
import type { RuntimeEvent } from "../contracts.ts";
import { heldSecretLongest, redactSecretsInText, scrubHeldSecrets } from "../redact.ts";
import { openPrivateKeyAt } from "../../shared/redact.ts";
import { heldTailStart, wordSafeCut } from "../../shared/stream-hold.ts";
import { stripLeakedSystemHarnessMessages } from "../../shared/system-message-guard.ts";
import { GROUP_GOAL_CONTROL_CLOSE, GROUP_GOAL_CONTROL_OPEN, visibleCoordinatorText } from "../group-goal-run.ts";

/** Past this much text since the last settled point, the start of the message is settled at a break. */
const SETTLE_AFTER = 2048;
/** A break is settled only with this much text after it already cleaned: a secret's value that follows its name. */
const SETTLE_LOOKAHEAD = 512;
/** A message with no break to settle at stops streaming here; its finished text still arrives whole. */
const MAX_WINDOW = 64 * 1024;
/** Open messages kept per thread: a message is let go when it completes, a tool starts or the turn ends. */
const MAX_OPEN = 8;
/** Messages remembered per thread as closed this turn, so a late word for one sends nothing. */
const MAX_CLOSED = 256;
/** The held-back length is the longest held value's, rounded up to this, so the lag tells little about it. */
const HELD_BUCKET = 32;
/** Text after a break must hold this much besides whitespace before the break settles: a secret's name, a long run of
 * blank space and its value still to come leave far less. */
const SETTLE_MIN_WORDS = 32;

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

/** `end`, short of anything still open: an unclosed private key, harness note or goal envelope. */
function shortOfOpen(text: string, end: number): number {
  const head = text.slice(0, end);
  for (const at of [openPrivateKeyAt(head), unclosed(head, HARNESS_OPEN, HARNESS_CLOSE), unclosed(head, GOAL_OPEN, GOAL_CLOSE)]) {
    if (at >= 0 && at < end) end = at;
  }
  return end;
}

/** Characters always held back while values are held: the longest one's length rounded up to a bucket, less one. A
 * value only begun at the end of the text is shorter than that, so it lies wholly in what waits. */
function heldBack(longest: number): number {
  return longest > 0 ? Math.ceil(longest / HELD_BUCKET) * HELD_BUCKET - 1 : 0;
}

/** `end`, moved back to the start of a whole held value that crosses it: the mask there shows that position anyway. */
function beforeWholeHeld(text: string, end: number, longest: number): number {
  if (longest < 2 || !Number.isFinite(longest) || end <= 0 || end >= text.length) return end;
  const from = Math.max(0, end - longest + 1);
  const near = text.slice(from, Math.min(text.length, end + longest - 1));
  const masked = scrubHeldSecrets(near);
  for (let cut = end; cut > from; cut--) if (masked.startsWith(scrubHeldSecrets(near.slice(0, cut - from)))) return cut;
  return from;
}

/** How much of `text` may be cleaned and sent while more is on the way: short of the word still being written, of
 * anything still open, and of the held-back tail. */
export function safeEnd(text: string): number {
  const longest = heldSecretLongest();
  const held = Math.max(0, text.length - heldBack(longest));
  const end = Math.min(heldTailStart(text), held < text.length ? wordSafeCut(text, held) : held);
  return beforeWholeHeld(text, shortOfOpen(text, end), longest);
}

/** How much of `text`, now complete, may be sent: all of it but anything still open. */
function finalEnd(text: string): number {
  return beforeWholeHeld(text, shortOfOpen(text, text.length), heldSecretLongest());
}

interface Stream {
  key: string;
  raw: string;
  /** `raw` before here is settled: cleaned once into `settled` and never again. */
  base: number;
  settled: string;
  sent: string;
  /** What was sent can no longer be extended consistently; the rest comes with the completion. */
  stopped: boolean;
  /** The last delta, for the rest of a thinking stream sent when it ends. */
  last: RuntimeEvent;
}

interface ThreadStreams {
  open: Map<string, Stream>;
  /** Messages closed or let go this turn: what comes later for one is not sent, its completion carries it. */
  closed: Set<string>;
}

const isTurnBoundary = (event: RuntimeEvent) =>
  event.type === "turn.started" || event.type === "turn.completed" || event.type === "cap.exhausted" ||
  event.type === "session.exited" || (event.type === "runtime.error" && event.terminal === true);

/** One instance per event bus: it sees reply text with its message ids, after the bus merges a burst of deltas. */
export class SafeText {
  private readonly threads = new Map<string, ThreadStreams>();

  /** A merged burst of a message's (or thinking's) deltas as it may be published: its newly safe text, or null while
   * there is none. */
  delta(event: RuntimeEvent): RuntimeEvent | null {
    if (event.type !== "content.delta") return event;
    let thread = this.threads.get(event.threadId);
    if (!thread) this.threads.set(event.threadId, (thread = { open: new Map(), closed: new Set() }));
    const key = `${event.streamKind}:${event.itemId ?? ""}`;
    if (thread.closed.has(key)) return null;
    let stream = thread.open.get(key);
    if (!stream) {
      stream = { key, raw: "", base: 0, settled: "", sent: "", stopped: false, last: event };
      thread.open.set(key, stream);
      if (thread.open.size > MAX_OPEN) this.close(thread, thread.open.values().next().value!);
    }
    stream.last = event;
    const fresh = this.extend(stream, event.delta);
    return fresh ? { ...event, delta: fresh } : null;
  }

  /** Any other event, before it is published: a message's completion closes that message; a tool's start, a thinking
   * item's start or a turn's end closes them all. Returns the rest of any thinking stream that ends here. */
  observe(event: RuntimeEvent): RuntimeEvent[] {
    const thread = this.threads.get(event.threadId);
    if (!thread) return [];
    if (event.type === "item.completed" && event.itemType === "assistant_text") {
      const stream = thread.open.get(`assistant_text:${event.itemId ?? ""}`);
      if (stream) this.close(thread, stream);
      return [];
    }
    if (!(event.type === "item.started" && (event.itemType === "tool" || event.itemType === "reasoning")) && !isTurnBoundary(event)) return [];
    const rest: RuntimeEvent[] = [];
    for (const stream of Array.from(thread.open.values())) {
      const flushed = stream.key.startsWith("reasoning_text:") ? this.finish(stream) : null;
      if (flushed) rest.push(flushed);
      this.close(thread, stream);
    }
    if (isTurnBoundary(event)) this.threads.delete(event.threadId);
    return rest;
  }

  private close(thread: ThreadStreams, stream: Stream): void {
    thread.open.delete(stream.key);
    // Thinking that names no item cannot be told apart from the next thinking: only its finished part was sent.
    if (stream.key.endsWith(":")) return;
    thread.closed.add(stream.key);
    if (thread.closed.size > MAX_CLOSED) thread.closed.delete(thread.closed.values().next().value!);
  }

  /** The rest of a stream whose text is complete, cleaned; null when there is none or it cannot be sent safely. */
  private finish(stream: Stream): RuntimeEvent | null {
    if (stream.stopped || stream.last.type !== "content.delta") return null;
    const window = stream.raw.slice(stream.base);
    const out = stream.settled + spaced(window.slice(0, finalEnd(window)));
    if (!out.startsWith(stream.sent) || out.length === stream.sent.length) return null;
    const delta = out.slice(stream.sent.length);
    stream.sent = out;
    return { ...stream.last, eventId: `${stream.last.eventId}-rest`, delta };
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

  /** Moves the settled start up to the latest paragraph, line or sentence end well before `end`, when cleaning the two
   * sides apart gives exactly what was sent: a break inside a note, an envelope or a masked value never settles, as
   * cleaning splits it differently. The text after the break must hold real words, not just blank space and
   * punctuation, so a secret's name and a value still to come are never cut apart there. */
  private settle(stream: Stream, window: string, end: number, out: string): void {
    const at = settlePoint(window, end - SETTLE_LOOKAHEAD);
    const after = window.slice(at, end);
    if (at > 0 && after.replace(/\s+/g, "").length >= SETTLE_MIN_WORDS) {
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

const SENTENCE_END = /[.!?](?=\s)|[。！？]/g;

/** The latest line or sentence end at or before `before`; failing one in the last 2 KB, the latest space; else 0. */
function settlePoint(window: string, before: number): number {
  if (before <= 0) return 0;
  let at = Math.max(window.lastIndexOf("\n", before - 1) + 1, 0);
  const from = Math.max(at, before - 2048);
  SENTENCE_END.lastIndex = 0;
  const span = window.slice(from, before);
  for (let end = SENTENCE_END.exec(span); end; end = SENTENCE_END.exec(span)) at = Math.max(at, from + end.index + 1);
  return at > before - 2048 ? at : Math.max(at, window.lastIndexOf(" ", before - 1) + 1);
}
