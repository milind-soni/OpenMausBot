import type { AskQuestion } from "../../../shared/ask-question";
import type { InboxRow } from "../../../shared/inbox";
import { personWait, type PersonWaitKind } from "../../../shared/person-wait";
import type { Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { cardQuestions } from "../QuestionCard";
import { accessRequestWords } from "../bot-access/access-card";
import { senderLabel, subjectOf, textOf } from "./inbox-view";

/** How a line is answered: by what it waits on the person for, else a reply to news that waits on one, or nothing but Done. */
export type InboxAnswerKind = PersonWaitKind | "reply" | "none";

/** The line as the chat shows it, so it answers here with the very card it asks with in the chat. */
export const asMessage = (row: InboxRow): Message => ({
  id: row.id, role: "bot", kind: row.secret ? "secret" : row.signIn ? "signin" : row.connector ? "connector" : "options", text: row.text, at: row.at,
  ...(row.card ? { card: row.card } : {}), ...(row.secret ? { secret: row.secret } : {}), ...(row.signIn ? { signIn: row.signIn } : {}),
  ...(row.connector ? { connector: row.connector } : {}),
} as Message);

export function answerKindOf(row: InboxRow): InboxAnswerKind {
  if (row.tab === "done") return "none";
  if (row.kind === "ask") {
    const wait = personWait(asMessage(row));
    if (wait) return wait.kind;
  }
  return row.tab === "info" && row.replies === true ? "reply" : "none";
}

const RECOMMENDED = /\s*[([]\s*recommended\s*[)\]]\s*$/i;

/** A choice as offered, with the "(Recommended)" a bot writes after the one it would pick taken off as a mark. */
export function recommendedOf(label: string): { label: string; recommended: boolean } {
  const bare = label.replace(RECOMMENDED, "");
  return bare && bare !== label ? { label: bare, recommended: true } : { label, recommended: false };
}

/** The one question a line asks when it asks just one; a set of several keeps the chat's own card with its tabs. */
export function singleQuestion(row: InboxRow): AskQuestion | null {
  if (!row.card) return null;
  const questions = cardQuestions(row.card);
  return questions.length === 1 ? questions[0]! : null;
}

/** A question's choices on one line: "Small team (recommended) / Enterprise / Solo developer". */
export function choicesLine(row: InboxRow): string | null {
  if (answerKindOf(row) !== "question") return null;
  const question = singleQuestion(row);
  if (!question?.options.length) return null;
  return question.options.map((option) => {
    const { label, recommended } = recommendedOf(option.label);
    return recommended ? `${label} ${t("inbox.recommendedInline")}` : label;
  }).join(" / ");
}

const firstLine = (text: string) => text.split("\n").map((line) => line.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";

/** What a line is about, in a few words: a question's short header or its first line, what an approval asks for, the
 * password or site asked for, else the first line of what it says. */
export function headlineOf(row: InboxRow): string {
  if (row.secret) return row.secret.label;
  if (row.signIn) return t("inbox.headline.signIn", { site: row.signIn.site });
  if (row.connector) return t("inbox.headline.connect", { app: row.connector.label });
  if (row.kind === "ask") {
    const question = row.card && !row.card.tool ? singleQuestion(row) : null;
    if (question) return question.header ?? firstLine(accessRequestWords(row.card)?.question ?? question.question);
    if (row.card?.questionRequest) return row.card.questionRequest.questions[0]?.header ?? subjectOf(row);
    return firstLine(row.card?.subtitle || row.card?.title || row.text) || subjectOf(row);
  }
  return firstLine(textOf(row)) || subjectOf(row);
}

/** The muted line under the headline when there is more to say and no choices to show. */
export function snippetOf(row: InboxRow): string | null {
  const text = textOf(row).replace(/\s+/g, " ").trim();
  const headline = headlineOf(row);
  if (!text || text === headline) return null;
  return text.startsWith(headline) ? text.slice(headline.length).trim() || null : text;
}

/** The search box keeps a line whose sender, conversation, headline, words or choices hold every word typed. */
export function matchesSearch(row: InboxRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [senderLabel(row), row.origin?.title ?? "", headlineOf(row), textOf(row), choicesLine(row) ?? ""].join(" ").toLowerCase();
  return words.every((word) => hay.includes(word));
}

/** Where the reading view goes once a line is answered: the next line down, else the one above, else back to the list. */
export function nextAfter(ids: readonly string[], id: string): string | null {
  const at = ids.indexOf(id);
  const rest = ids.filter((one) => one !== id);
  if (!rest.length) return null;
  if (at < 0) return rest[0]!;
  return rest[at] ?? rest[at - 1] ?? rest[0]!;
}
