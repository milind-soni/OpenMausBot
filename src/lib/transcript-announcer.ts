// What a screen reader hears from a conversation. The transcript itself is
// not a live region (a polite log re-reads the ticking "Thinking 3s", every
// activity label and every chip), so this decides the few moments worth one
// short sentence: a reply that has finished, a turn that failed, and an
// approval that is waiting. A stop the person asked for is none of those.
import { t } from "@/lib/i18n";
import { failedTurnCause } from "../../shared/failed-turn";
import type { Message } from "@/state/store";

export interface TranscriptSnapshot {
  /** A turn is running (for a room: any member is working). */
  busy: boolean;
  /** The newest bot text in the thread. */
  reply?: { id: string; name: string; text: string };
  /** The newest failed turn in the thread. */
  failure?: { id: string; name: string; cause: string };
  /** The first open approval, if any. */
  approval?: { id: string; name: string };
}

export interface AnnouncerMemory {
  replyId?: string;
  failureId?: string;
  approvalId?: string;
  /** A turn has run since the last reply was announced. History loading
   * into an idle thread never sets it, so old replies are never read out. */
  sawBusy: boolean;
}

/** What is already on screen when a thread opens: nothing to announce. */
export function announcerBaseline(snapshot: TranscriptSnapshot): AnnouncerMemory {
  return {
    replyId: snapshot.reply?.id,
    failureId: snapshot.failure?.id,
    approvalId: snapshot.approval?.id,
    sawBusy: snapshot.busy,
  };
}

export function nextAnnouncement(
  snapshot: TranscriptSnapshot,
  memory: AnnouncerMemory,
): { memory: AnnouncerMemory; text?: string } {
  const next: AnnouncerMemory = {
    ...memory,
    approvalId: snapshot.approval?.id,
    failureId: snapshot.failure?.id,
    sawBusy: memory.sawBusy || snapshot.busy,
  };
  const said: string[] = [];
  if (snapshot.approval && snapshot.approval.id !== memory.approvalId) {
    said.push(t("chat.announce.approval", { name: snapshot.approval.name }));
  }
  // Only once the turn is over: a reply between tool calls is not the answer.
  if (!snapshot.busy && next.sawBusy) {
    next.sawBusy = false;
    const reply = snapshot.reply;
    const stoppedReply = Boolean(reply && isUserStop(reply.text));
    if (reply && reply.id !== memory.replyId && !stoppedReply) {
      next.replyId = reply.id;
      const summary = replySummary(reply.text);
      said.push(summary
        ? t("chat.announce.replied", { name: reply.name, text: summary })
        : t("chat.announce.repliedEmpty", { name: reply.name }));
    } else if (snapshot.failure && snapshot.failure.id !== memory.failureId && !isUserStop(snapshot.failure.cause)) {
      const summary = replySummary(snapshot.failure.cause);
      said.push(summary
        ? t("chat.announce.failed", { name: snapshot.failure.name, text: summary })
        : t("chat.announce.failedEmpty", { name: snapshot.failure.name }));
    }
  }
  return said.length ? { memory: next, text: said.join(" ") } : { memory: next };
}

export function latestReply(
  messages: readonly Message[],
  nameOf: (message: Message) => string,
): TranscriptSnapshot["reply"] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "bot" && message.kind === "text" && message.text?.trim()) {
      return { id: message.id, name: nameOf(message), text: message.text };
    }
  }
  return undefined;
}

/** The newest failed-turn row. A stop stored as an ordinary activity name
 * has no error cause, so it is not a failure. */
export function latestFailure(
  messages: readonly Message[],
  nameOf: (message: Message) => string,
): TranscriptSnapshot["failure"] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const cause = message.kind === "activity" && message.tool ? failedTurnCause(message.tool.name) : null;
    if (cause) return { id: message.id, name: nameOf(message), cause };
  }
  return undefined;
}

const SUMMARY_LIMIT = 120;

/** A whole message that is only the person stopping the turn. A real error
 * that merely mentions a cancellation still counts as a failure. */
function isUserStop(text: string): boolean {
  const body = text.trim().replace(/^provider returned a(?: streaming)? completion error:\s*/i, "").trim();
  if (!body) return false;
  return [
    /^context\s+canceled\.?$/i,
    /^(?:context\s+canceled)?\s*the\s+request\s+was\s+cancell?ed\s+by\s+the\s+client\.?$/i,
    /^(?:(?:the|this)\s+)?operation\s+was\s+aborted\.?$/i,
    /^(?:the\s+)?request\s+was\s+aborted\.?$/i,
    /^the\s+user\s+aborted\s+a\s+request\.?$/i,
  ].some((pattern) => pattern.test(body));
}

/** The reply's first sentence as plain words, short enough to hear in one
 * breath. The full reply is one arrow key away in the transcript. */
export function replySummary(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // ASCII stops need a space so "1.2" stays one sentence. Arabic ؟ and
  // CJK 。！？ end a sentence even when the next word is not spaced.
  const sentence = /^(.+?(?:[.!?](?=\s|$)|[؟。！？]))/u.exec(plain)?.[1] ?? plain;
  if (sentence.length <= SUMMARY_LIMIT) return sentence;
  const cut = sentence.slice(0, SUMMARY_LIMIT);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
