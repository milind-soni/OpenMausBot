/**
 * A bot's draft bug report about OpenMausBot itself. The person reviews and
 * edits it, then sends it from the desktop app or dismisses it: a bot never
 * sends anything to the OpenMausBot team.
 */
import type { BugReportCardData } from "./wire.ts";

/** In characters. The OpenMausBot team's server takes a description of at most 10,000. */
export const BUG_REPORT_LIMITS = { summary: 200, details: 8_000, description: 10_000 } as const;

/** What the person first sees in the card's editor: the summary, a blank line, the details. */
export function bugReportDraftText(card: Pick<BugReportCardData, "summary" | "details">): string {
  return (card.details ? `${card.summary}\n\n${card.details}` : card.summary).slice(0, BUG_REPORT_LIMITS.description);
}

/** How a draft ended, or null while it is open. */
export function bugReportOutcome(card: { sent?: unknown; dismissed?: unknown }): "sent" | "dismissed" | null {
  if (card.sent === true) return "sent";
  if (card.dismissed === true) return "dismissed";
  return null;
}

/** A draft still offering Send and Dismiss: the set a newer draft from the same bot supersedes. In a room only that
 * bot's own drafts count. */
export function isPendingBugReport(
  message: { kind?: unknown; bugReport?: { sent?: unknown; dismissed?: unknown; superseded?: unknown }; from?: { botId?: unknown } },
  botId: string,
  roomThread: boolean,
): boolean {
  return (
    message.kind === "bugreport" &&
    message.bugReport !== undefined &&
    bugReportOutcome(message.bugReport) === null &&
    message.bugReport.superseded !== true &&
    (!roomThread || message.from?.botId === botId)
  );
}

/** The transcript line under the card, and all a client that does not know the card draws. */
export function bugReportFallbackText(botName: string, summary: string): string {
  return `${botName} drafted a bug report for the OpenMausBot team: “${summary}”. Open this conversation in the OpenMausBot desktop app to review and send it.`;
}

export function bugReportResumePrompt(outcome: "sent" | "dismissed", reportId?: string): string {
  return outcome === "sent"
    ? `OpenMausBot bug report update: the person sent your bug report to the OpenMausBot team${reportId ? ` (report ${reportId})` : ""}. Tell them in one short line that it was sent, then continue the task if you can.`
    : "OpenMausBot bug report update: the person dismissed your bug report draft, so nothing was sent. Do not draft it again unless they ask. Continue the task if you can, or briefly say what still does not work.";
}
