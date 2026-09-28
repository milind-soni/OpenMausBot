// What a screen reader hears from a conversation. The transcript itself is
// not a live region (a polite log re-reads the ticking "Thinking 3s", every
// activity label and every chip), so this decides the few moments worth one
// short sentence: a reply that has finished, and an approval that is waiting.
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

export interface TranscriptSnapshot {
  /** A turn is running (for a room: any member is working). */
  busy: boolean;
  /** The newest bot text in the thread. */
  reply?: { id: string; name: string; text: string };
  /** The first open approval, if any. */
  approval?: { id: string; name: string };
}

export interface AnnouncerMemory {
  replyId?: string;
  approvalId?: string;
  /** A turn has run since the last reply was announced. History loading
   * into an idle thread never sets it, so old replies are never read out. */
  sawBusy: boolean;
}

/** What is already on screen when a thread opens: nothing to announce. */
export function announcerBaseline(snapshot: TranscriptSnapshot): AnnouncerMemory {
  return { replyId: snapshot.reply?.id, approvalId: snapshot.approval?.id, sawBusy: snapshot.busy };
}

export function nextAnnouncement(
  snapshot: TranscriptSnapshot,
  memory: AnnouncerMemory,
): { memory: AnnouncerMemory; text?: string } {
  const next: AnnouncerMemory = { ...memory, approvalId: snapshot.approval?.id, sawBusy: memory.sawBusy || snapshot.busy };
  const said: string[] = [];
  if (snapshot.approval && snapshot.approval.id !== memory.approvalId) {
    said.push(t("chat.announce.approval", { name: snapshot.approval.name }));
  }
  // Only once the turn is over: a reply between tool calls is not the answer.
  if (!snapshot.busy && next.sawBusy) {
    next.sawBusy = false;
    if (snapshot.reply && snapshot.reply.id !== memory.replyId) {
      next.replyId = snapshot.reply.id;
      const summary = replySummary(snapshot.reply.text);
      said.push(summary
        ? t("chat.announce.replied", { name: snapshot.reply.name, text: summary })
        : t("chat.announce.repliedEmpty", { name: snapshot.reply.name }));
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

const SUMMARY_LIMIT = 120;

/** The reply's first sentence as plain words, short enough to hear in one
 * breath. The full reply is one arrow key away in the transcript. */
export function replySummary(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(plain)?.[1] ?? plain;
  if (sentence.length <= SUMMARY_LIMIT) return sentence;
  const cut = sentence.slice(0, SUMMARY_LIMIT);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
