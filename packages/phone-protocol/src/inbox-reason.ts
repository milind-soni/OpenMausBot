import type { InboxRow } from "./inbox.ts";
import { cardKind } from "./live-approval.ts";

/** Why a line is in a person's inbox, the first thing its row says. "asked": a bot's question, or a password, sign-in or
 * app it needs; "approval": an action, a change to review or someone asking for access waits on their OK; "mentioned":
 * a teammate or a bot @-named them; "replied": a teammate answered their message; "messaged": a bot or a teammate wrote to
 * them; "notice": something went wrong that needs a look; "finished": a routine's report; "shared": a bot or a conversation
 * was shared with them. */
export type InboxReason = "asked" | "approval" | "mentioned" | "replied" | "messaged" | "notice" | "finished" | "shared";

/** The reasons only the server can tell, carried on a line as `reason`; every other reason follows from the line itself. */
export type InboxSaidReason = Extract<InboxReason, "asked" | "mentioned" | "replied" | "shared">;

/** "for-you": it waits on the person or names them, and counts toward the inbox's number; "activity": news, shown
 * bold while unread and never counted. */
export type InboxGroup = "for-you" | "activity";

type ReasonRow = Pick<InboxRow, "kind" | "card" | "reason">;

export function inboxReason(row: ReasonRow): InboxReason {
  if (row.kind === "ask") return row.card && (row.card.accessRequest || cardKind(row.card) !== "question") ? "approval" : "asked";
  if (row.reason) return row.reason;
  if (row.kind === "result") return "finished";
  return row.kind === "notice" ? "notice" : "messaged";
}

const ACTIVITY: ReadonlySet<InboxReason> = new Set(["finished", "shared"]);

export const inboxGroup = (row: ReasonRow): InboxGroup => (ACTIVITY.has(inboxReason(row)) ? "activity" : "for-you");

/** A line the inbox's number counts: in For you, and waiting on the person or not read yet. */
export const countsForYou = (row: ReasonRow & Pick<InboxRow, "tab" | "unread">): boolean =>
  inboxGroup(row) === "for-you" && (row.tab === "needs-you" || (row.tab === "info" && row.unread));
