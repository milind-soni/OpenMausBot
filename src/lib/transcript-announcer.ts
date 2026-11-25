// The transcript is not a live region: a polite log would re-read every ticking timer and chip.
import { t } from "@/lib/i18n";
import { failedTurnCause } from "../../shared/failed-turn";
import type { Message } from "@/state/store";
import { isCancelledTranscriptRow } from "../../shared/client-cancel";

export interface TranscriptSnapshot {
  busy: boolean;
  reply?: { id: string; name: string; text: string };
  failure?: { id: string; name: string; cause: string; partial?: boolean };
  approval?: { id: string; name: string };
}

export interface AnnouncerMemory {
  replyId?: string;
  failureId?: string;
  approvalId?: string;
  sawBusy: boolean;
}

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
        ? t(snapshot.failure.partial ? "chat.announce.partial" : "chat.announce.failed", { name: snapshot.failure.name, text: summary })
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
    if (message.role === "bot" && message.kind === "text" && message.text?.trim() && !isCancelledTranscriptRow(message)) {
      return { id: message.id, name: nameOf(message), text: message.text };
    }
  }
  return undefined;
}

export function latestFailure(
  messages: readonly Message[],
  nameOf: (message: Message) => string,
): TranscriptSnapshot["failure"] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const cause = message.kind === "activity" && message.tool ? failedTurnCause(message.tool.name) : null;
    if (cause) return { id: message.id, name: nameOf(message), cause, ...(message.tool!.partial ? { partial: true } : {}) };
  }
  return undefined;
}

const SUMMARY_LIMIT = 120;

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

export function replySummary(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // ASCII stops need a following space ("1.2" stays whole); Arabic and CJK stops do not.
  const sentence = /^(.+?(?:[.!?](?=\s|$)|[؟。！？]))/u.exec(plain)?.[1] ?? plain;
  if (sentence.length <= SUMMARY_LIMIT) return sentence;
  const cut = sentence.slice(0, SUMMARY_LIMIT);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
