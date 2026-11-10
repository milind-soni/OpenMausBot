import { formatQuestionAnswers, questionChoices } from "../../../shared/ask-question";
import type { InboxRow, InboxTab, InboxView } from "../../../shared/inbox";
import type { NeedsYouItem } from "../../../shared/today";
import { liveCardKind } from "../../../shared/live-approval";
import { t } from "@/lib/i18n";
import { dismissResponse, type CardResponse } from "@/lib/card-answer";
import { accessRequestWords, cardAnswerFor } from "../bot-access/access-card";

/** The Needs you lines the inbox's card in the chat shows, the newest first. */
export const CARD_ROWS = 3;

export const rowsIn = (view: InboxView | null, tab: InboxTab): InboxRow[] => (view?.rows ?? []).filter((row) => row.tab === tab);

/** The inbox as one list, newest first: what waits on the person and their news; a settled line is read from where it
 * came, not listed again. */
export const listedRows = (view: InboxView | null): InboxRow[] => (view?.rows ?? []).filter((row) => row.tab !== "done").sort((a, b) => b.at - a.at);

export function tabCounts(view: InboxView | null): Record<InboxTab, number> {
  const counts: Record<InboxTab, number> = { "needs-you": 0, info: 0, done: 0 };
  for (const row of view?.rows ?? []) counts[row.tab] += 1;
  return counts;
}

/** What the Inbox row counts: every line waiting on the person, and news they have not read. */
export const waitingCount = (view: InboxView | null): number => (view?.rows ?? []).filter((row) => row.tab === "needs-you" || (row.tab === "info" && row.unread)).length;

/** What a team's person is told needs them beyond the inbox's lines: something to fix, or a question in their own chat. */
export const inboxFixes = (items: readonly NeedsYouItem[] | undefined, view: InboxView | null): NeedsYouItem[] =>
  (items ?? []).filter((item) => item.kind !== "message" && !(item.kind === "question" && view?.rows.some((row) => row.tab === "needs-you" && row.origin?.threadId === item.threadId)));

/** The conversation an answer to this line goes to: a team's copy, in the inbox's own, or where it was asked anywhere else. */
export const answerThread = (view: Pick<InboxView, "threadId"> | null, row: Pick<InboxRow, "origin">): string | null => view?.threadId ?? row.origin?.threadId ?? null;

/** Who a line is from, and for whom when a bot was working for another or a guest asked. */
export function senderLabel(row: Pick<InboxRow, "from" | "workingFor" | "askedBy">): string {
  const name = row.from.name;
  if (row.askedBy) return row.askedBy.name ? t("inbox.askedBy", { name, who: row.askedBy.name }) : t("inbox.askedBySomeone", { name });
  return row.workingFor ? t("inbox.workingFor", { name, other: row.workingFor.name }) : name;
}

/** The conversation a line came from, when its subject doesn't already say it. */
export const placeOf = (row: Pick<InboxRow, "kind" | "origin">): string | null => (row.kind !== "message" && row.origin?.title ? t("inbox.in", { title: row.origin.title }) : null);

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
