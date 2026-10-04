// What a transcript row needs from the rest of its thread, worked out once
// per message list rather than by every row on every render: the versions
// of an edited question, the message a reply quotes, the row a failed
// turn's Retry belongs to. Plus the day labels both chats and rooms put
// between days, from one formatter instead of a new one per row.
import type { Message } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";

export interface TranscriptLookups {
  /** Every version of an edited question (itself and the forks that
   * replaced it), oldest first. Undefined when it was never edited. */
  editVersions(message: Message): readonly Message[] | undefined;
  /** The message a reply quotes, on any branch. */
  replyTarget(message: Message): Message | undefined;
  /** The last conversational row of the branch. Settlement can append
   * bookkeeping after a failure; Retry still belongs to this row. */
  retryableId: string | undefined;
}

/** `all` is every message the client holds for the thread (all branches);
 * `branch` is the one on screen. */
export function transcriptLookups(all: readonly Message[], branch: readonly Message[]): TranscriptLookups {
  const byId = new Map<string, Message>();
  // An edit forks the question: its versions are the user texts that share
  // a parent.
  const forks = new Map<string | null, Message[]>();
  for (const message of all) {
    byId.set(message.id, message);
    if (message.role !== "user" || message.kind !== "text") continue;
    const parent = message.parentId ?? null;
    const siblings = forks.get(parent);
    if (siblings) siblings.push(message);
    else forks.set(parent, [message]);
  }
  for (const siblings of forks.values()) siblings.sort((a, b) => a.at - b.at);
  let retryableId: string | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const message = branch[i]!;
    if (message.kind !== "digest" && message.kind !== "compaction") {
      retryableId = message.id;
      break;
    }
  }
  return {
    editVersions(message) {
      if (message.role !== "user" || message.kind !== "text") return undefined;
      const versions = forks.get(message.parentId ?? null);
      return versions && versions.length > 1 ? versions : undefined;
    },
    replyTarget: (message) => (message.replyToId ? byId.get(message.replyToId) : undefined),
    retryableId,
  };
}

/** The local calendar day of a timestamp as a whole number, so two
 * timestamps fall on the same day exactly when their numbers are equal,
 * and the count between days stays whole across clock changes. */
export function localDay(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

let dates: { locale: string; format: (at: number) => string } | null = null;

/** "Today" / "Yesterday" / "Mon, Aug 11" in the app language. `today` is
 * localDay of now. */
export function dayLabel(at: number, today = localDay(Date.now())): string {
  const daysAgo = today - localDay(at);
  if (daysAgo === 0) return t("chat.day.today");
  if (daysAgo === 1) return t("chat.day.yesterday");
  // what toLocaleDateString says, where a formatter would throw
  if (Number.isNaN(daysAgo)) return "Invalid Date";
  const locale = activeLocale();
  if (dates?.locale !== locale) {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric" });
    dates = { locale, format: (value) => formatter.format(value) };
  }
  return dates.format(at);
}
