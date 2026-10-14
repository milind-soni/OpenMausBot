// A bot's draft bug report is a card in its own conversation. The desktop app sends the report; the server only
// records what the person did with the draft and resumes the bot.
import { BUG_REPORT_LIMITS, bugReportFallbackText, bugReportOutcome, bugReportResumePrompt, isPendingBugReport } from "../shared/bug-report.ts";
import type { MausColor } from "../shared/wire.ts";
import type { AgentCardResult, AgentCardStore } from "./chat-widgets.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";

export type BugReportOutcome = "sent" | "dismissed";

const GUEST_REFUSAL = "draft_bug_report is not available in a conversation a guest is driving.";
const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Called once the route has checked that the conversation is the calling bot's own. */
export function draftBugReportCard(args: {
  store: AgentCardStore;
  bot: { id: string; name: string; color: MausColor };
  threadId: string;
  input: Record<string, unknown>;
  guest?: boolean;
  authored?(messageId: string): void;
}): AgentCardResult {
  const { store, bot, threadId, input } = args;
  if (args.guest) return { ok: false, status: 403, error: GUEST_REFUSAL };
  // Scrubbed before clipped: half a key no longer looks like one.
  const field = (value: unknown, max: number) => typeof value === "string" ? redactSecretsInText(value.trim()).slice(0, max).trim() : "";
  const summary = field(input.summary, BUG_REPORT_LIMITS.summary).replace(/\s+/g, " ");
  if (!summary) return { ok: false, status: 400, error: "summary: one line on what failed in OpenMausBot." };
  const details = field(input.details, BUG_REPORT_LIMITS.details);
  const room = Boolean(store.groupByThread(threadId));
  // No `from` in a direct thread: there a bot-authored row carrying one is replayed as another bot's line.
  const message = store.appendMessage(threadId, {
    role: "bot",
    kind: "bugreport",
    text: bugReportFallbackText(bot.name, summary),
    ...(room ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
    bugReport: { summary, details },
  });
  for (const prior of store.messagesFor(threadId)) {
    if (prior.id === message.id || !isPendingBugReport(prior, bot.id, room)) continue;
    store.patchMessage(threadId, prior.id, { bugReport: { ...prior.bugReport!, superseded: true } });
  }
  args.authored?.(message.id);
  return { ok: true, messageId: message.id };
}

export interface BugReportSettleDeps {
  store: {
    activePath(threadId: string): Message[];
    patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
  };
  /** The conversation is this bot's own: its direct thread, one of its tasks, or a room it is in. */
  ownerOf(botId: string, threadId: string): { group?: unknown } | null;
  /** Answers the turn parked on this card; false when none is parked on it yet. */
  resume(threadId: string, messageId: string, text: string): boolean;
}

export function settleBugReport(
  deps: BugReportSettleDeps,
  botId: string,
  threadId: string,
  messageId: string,
  outcome: BugReportOutcome,
  rawReportId?: unknown,
): { status: number; body: Record<string, unknown> } {
  const owner = deps.ownerOf(botId, threadId);
  const message = owner ? deps.store.activePath(threadId).find((candidate) => candidate.id === messageId) : undefined;
  // In a room, only the drafting bot's own card.
  if (!message || message.kind !== "bugreport" || !message.bugReport || (owner?.group && message.from?.botId !== botId)) {
    return { status: 404, body: { error: "no such bug report draft" } };
  }
  const card = message.bugReport;
  if (card.superseded) return { status: 409, body: { error: "this bug report draft was replaced by a newer one" } };
  const settled = bugReportOutcome(card);
  if (settled && settled !== outcome) return { status: 409, body: { error: `this bug report draft was already ${settled}` } };
  if (settled && card.resumed) return { status: 200, body: { [outcome]: true, resumed: true } };
  const reportId = typeof rawReportId === "string" && REPORT_ID.test(rawReportId) ? rawReportId : card.reportId;
  const resumed = deps.resume(threadId, message.id, bugReportResumePrompt(outcome, reportId));
  deps.store.patchMessage(threadId, message.id, {
    bugReport: {
      ...card,
      ...(outcome === "sent" ? { sent: true, ...(reportId ? { reportId } : {}) } : { dismissed: true }),
      ...(resumed ? { resumed: true } : {}),
    },
  });
  return { status: 200, body: { [outcome]: true, resumed } };
}
