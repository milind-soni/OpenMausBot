// A person's inbox for the inbox panel's tests and preview: two asks waiting on them, news, and one settled ask.
import type { InboxRow, InboxView } from "../../shared/inbox";

export const INBOX_NOW = new Date(2026, 9, 28, 15, 0).getTime();

export const approvalRow: InboxRow = {
  id: "line-approval", kind: "ask", tab: "needs-you", unread: true, at: INBOX_NOW - 2 * 60_000,
  from: { name: "Reporter", botId: "reporter" }, origin: { botId: "reporter", threadId: "rep-main", title: "Reporter" }, text: "Run: rm -rf ./build",
  card: { title: "Approval needed", subtitle: "rm -rf ./build", options: ["Allow", "Deny"], requestId: "req-approval", tool: "Bash", requestType: "permission" },
};
export const questionRow: InboxRow = {
  id: "line-question", kind: "ask", tab: "needs-you", unread: false, at: INBOX_NOW - 20 * 60_000,
  from: { name: "Scout", botId: "scout" }, origin: { botId: "scout", threadId: "scout-main", title: "Launch page" }, text: "Which landing page should I rewrite?",
  card: { title: "Your bot has a question", subtitle: "Which landing page should I rewrite?", options: ["Home", "Pricing"], requestId: "req-question", requestType: "question" },
};
export const messageRow: InboxRow = {
  id: "line-message", kind: "message", tab: "info", unread: true, at: INBOX_NOW - 65 * 60_000, replies: true,
  from: { name: "Cleo", email: "cleo@acme.test" }, via: { botId: "scout", name: "Scout" }, text: "The launch moved to Friday. Can you check the numbers before then?",
};
export const reportRow: InboxRow = {
  id: "line-report", kind: "result", tab: "info", unread: false, at: INBOX_NOW - 3 * 60 * 60_000,
  from: { name: "Reporter", botId: "reporter" }, origin: { botId: "reporter", threadId: "rep-daily", title: "Daily digest" }, text: "Daily digest: 3 new leads, 1 reply waiting.",
};
export const settledRow: InboxRow = {
  id: "line-settled", kind: "ask", tab: "done", unread: false, at: INBOX_NOW - 26 * 60 * 60_000,
  from: { name: "Reporter", botId: "reporter" }, text: "Run: npm test",
  card: { title: "Approval needed", subtitle: "npm test", options: ["Allow", "Deny"], requestId: "req-settled", tool: "Bash", requestType: "permission", answered: "allow" },
};

export const inboxView = (rows: InboxRow[] = [approvalRow, questionRow, messageRow, reportRow, settledRow]): InboxView => ({
  botId: "bens-chief", threadId: "inbox", rows,
  anchor: rows.find((row) => row.kind === "ask")?.id ?? rows[0]?.id ?? null,
});
