import { formatQuestionAnswers, questionChoices } from "../../../shared/ask-question";
import type { InboxRow, InboxTab, InboxView } from "../../../shared/inbox";
import { liveCardKind } from "../../../shared/live-approval";
import { t } from "@/lib/i18n";
import { dismissResponse, type CardResponse } from "@/lib/card-answer";
import { accessRequestWords, cardAnswerFor } from "../bot-access/access-card";

export const INBOX_TABS: readonly InboxTab[] = ["needs-you", "info", "done"];
/** The Needs you lines the inbox's card in the chat shows, the newest first. */
export const CARD_ROWS = 3;

export const rowsIn = (view: InboxView | null, tab: InboxTab): InboxRow[] => (view?.rows ?? []).filter((row) => row.tab === tab);

export function tabCounts(view: InboxView | null): Record<InboxTab, number> {
  const counts: Record<InboxTab, number> = { "needs-you": 0, info: 0, done: 0 };
  for (const row of view?.rows ?? []) counts[row.tab] += 1;
  return counts;
}

/** What an ask asks: an approval, a question, or something to review where it was asked; null for anything else or an
 * ask already settled. */
export const askOf = (row: InboxRow) => (row.kind === "ask" && row.tab === "needs-you" ? liveCardKind(row.card) : null);

/** The subject a row shows after its sender: what kind of line it is, or the conversation a message came from. */
export function subjectOf(row: InboxRow): string {
  if (row.kind === "ask") return row.card?.tool ? t("inbox.subject.approval") : row.card?.requestType === "question" || row.card?.questionRequest ? t("inbox.subject.question") : row.card?.title || t("inbox.subject.approval");
  if (row.kind === "result") return t("inbox.subject.result");
  if (row.kind === "notice") return t("inbox.subject.notice");
  return row.origin?.title ?? t("inbox.subject.message");
}

/** The choices a question offers as buttons, when one tap answers it: a single question, one pick. */
export const choicesOf = (row: InboxRow): string[] => {
  const card = row.card;
  if (askOf(row) !== "question" || !card) return [];
  if (card.questionRequest) return questionChoices(card.questionRequest.questions) ?? [];
  return accessRequestWords(card)?.options ?? card.options;
};

/** What a line says: an ask for access in this person's language, anything else as it came. */
export const textOf = (row: InboxRow): string => accessRequestWords(row.card)?.question ?? row.text;

/** What a tap on one of a question's choices sends. */
export function choiceResponse(row: InboxRow, label: string): CardResponse {
  const questions = row.card?.questionRequest?.questions;
  return { behavior: "answer", message: questions ? formatQuestionAnswers(questions, [[label]]) : cardAnswerFor(row.card, label) };
}

/** What closing a question without an answer sends; an approval closes as a deny. */
export const closeResponse = (row: InboxRow): CardResponse => dismissResponse(row.card ?? {});

export type QuickAction = "allow" | "deny" | "reply" | "close" | "done" | "open";

/** The actions a row offers on hover or focus, the ask's own answer first. */
export function quickActions(row: InboxRow): QuickAction[] {
  const ask = askOf(row);
  if (ask === "approval") return ["allow", "deny", "reply"];
  if (ask === "question") return ["reply", "close"];
  if (ask === "review") return ["open"];
  if (row.tab === "info") return ["done", "open"];
  return ["open"];
}
