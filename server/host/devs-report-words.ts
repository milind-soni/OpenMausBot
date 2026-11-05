import { serverLine } from "../server-lines.ts";
import type { SendOutcome } from "../devs-report-send.ts";

export const sentLine = (reportId: string, contact?: string, language?: string) => contact
  ? serverLine(language, "server.reports.sentReply", { report: reportId, contact }) : serverLine(language, "server.reports.sent", { report: reportId });
export const laterLine = (reportId: string, contact: string | undefined, language: string | undefined) => contact
  ? serverLine(language, "server.reports.sentLaterReply", { report: reportId, contact }) : serverLine(language, "server.reports.sentLater", { report: reportId });
export function notYetLine(outcome: Extract<SendOutcome, { retry: true }>, language: string | undefined): string {
  const minutes = outcome.retryAfterMs ? Math.max(1, Math.ceil(outcome.retryAfterMs / 60_000)) : 0;
  const why = serverLine(language, outcome.why === "limited" ? "server.reports.why.limited" : outcome.why === "offline" ? "server.reports.why.offline" : "server.reports.why.busy");
  const when = minutes ? serverLine(language, minutes === 1 ? "server.reports.when.minute" : "server.reports.when.minutes", { count: minutes })
    : serverLine(language, "server.reports.when.soon");
  return serverLine(language, "server.reports.notYet", { why, when });
}
export const refusedLine = (detail: string, language: string | undefined) => serverLine(language, "server.reports.refused", { detail: detail.replace(/[.\s]+$/, "") });
export const fullLine = (count: number, language: string | undefined) => serverLine(language, "server.reports.full", { count });
export const droppedLine = (language: string | undefined) => serverLine(language, "server.reports.dropped");
