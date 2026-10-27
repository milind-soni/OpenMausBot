import { noticeFailure, type ChatNoticeKey } from "../chat-notices.ts";
import type { SendOutcome } from "../devs-report-send.ts";

function reportLine(key: ChatNoticeKey, params?: Record<string, string>) {
  const { message: line, text } = noticeFailure(key, params);
  return { line, text };
}

export function sentReportLine(id: string, contact?: string, later = false) {
  const key = later ? contact ? "chat.notice.reportLaterContact" : "chat.notice.reportLater"
    : contact ? "chat.notice.reportSentContact" : "chat.notice.reportSent";
  return reportLine(key, { id, ...(contact ? { contact } : {}) });
}

export function notYetReportLine(outcome: Extract<SendOutcome, { retry: true }>) {
  const minutes = outcome.retryAfterMs ? Math.max(1, Math.ceil(outcome.retryAfterMs / 60_000)) : 0;
  if (outcome.why !== "limited") {
    const why = outcome.why === "offline" ? "the MausBot team's server could not be reached" : "the MausBot team's server could not take it right now";
    return { line: `Not sent yet: ${why}. The report is saved and goes on its own${minutes ? ` in about ${minutes} minute${minutes === 1 ? "" : "s"}` : " as soon as it can"}, so there is no need to send it again.`, text: undefined };
  }
  return reportLine(minutes ? minutes === 1 ? "chat.notice.reportWaitingOne" : "chat.notice.reportWaitingMany" : "chat.notice.reportWaiting",
    { why: "chat.notice.part.reportLimited", ...(minutes ? { minutes: String(minutes) } : {}) });
}

export const refusedReportLine = (detail: string) => ({ line: `The MausBot team's server refused this bug report, so nothing was sent: ${detail.replace(/[.\s]+$/, "")}.`, text: undefined });
export const fullReportLine = (count: number) => reportLine("chat.notice.reportFull", { count: String(count) });
export const droppedReportLine = () => reportLine("chat.notice.reportDropped");
