import { randomUUID } from "node:crypto";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { approvalEvidence, reviewApproval, type ReviewAction, type ReviewVerdict } from "../approval-review.ts";
import { appendDecision } from "../decision-log.ts";
import { redactSecretsInText } from "../redact.ts";
import type { AppConfig } from "../config.ts";
import type { Store } from "../store.ts";
import type { ProviderInstance } from "../contracts.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import type { UsageRow } from "../usage-ledger.ts";
import { automaticApprovalFloor } from "./automatic-approval-floor.ts";

export function createApprovalReviewService(deps: {
  store(): Store;
  config(): AppConfig;
  watchdog(): { setCheckpointOwnsDeadline(threadId: string, value: boolean): void };
  getProvider(id: string): ProviderInstance | undefined;
  providerRefusal(provider: ProviderInstance): string | null | undefined;
  assertBudget(): void;
  bookUsage(row: Omit<UsageRow, "at" | "costSource">, countsKnown: boolean, threadId: string): void;
  sourceApprovalMode(botId: string, threadId: string): ApprovalMode;
  roomApprovalMode(threadId: string, botId: string): ApprovalMode;
  authoritySources?(botId: string, threadId: string): Array<{ botId: string; threadId: string; turnId: string }>;
  dataDir: string;
}) {
  const reviewSessionSelections = new Map<string, ModelSelection>();
  const approvalReviewControllers = new Map<string, Set<AbortController>>();
  const connectorReviewGrants = new Map<string, { settings: string; expiresAt: number; current(): boolean }>();
function reviewGrantKey(threadId: string, tool: string, args: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, part]) => [key, canonical(part)])) : value;
  return `${threadId}:${JSON.stringify([tool.replace(/^(?:mcp__composio__|composio_)/i, "").toLowerCase(), canonical(args)])}`;
}

function authority(botId: string, threadId: string) {
  const sources = deps.authoritySources?.(botId, threadId) ?? [];
  const messages = deps.store().activePath(threadId);
  const authorityMessages = sources.map(source => deps.store().activePath(source.threadId));
  const standingInstructions = sources.length ? JSON.stringify([...sources.map(source => ({
    botId: source.botId, soul: deps.store().bot(source.botId)?.soul,
  })), { botId, soul: deps.store().bot(botId)?.soul }]) : deps.store().bot(botId)?.soul;
  return { messages, authorityMessages, standingInstructions, identity: JSON.stringify({
    sources: sources.map(source => ({ ...source, mode: deps.sourceApprovalMode(source.botId, source.threadId) })),
    standingInstructions, evidence: approvalEvidence(messages, authorityMessages),
  }) };
}
function authorizationCurrent(botId: string, threadId: string, isCurrent: () => boolean) {
  const identity = authority(botId, threadId).identity;
  const settings = JSON.stringify(deps.config().approvalReview ?? {});
  return () => {
    try { return isCurrent() && settings === JSON.stringify(deps.config().approvalReview ?? {}) && authority(botId, threadId).identity === identity; }
    catch { return false; }
  };
}
function carryConnectorApproval(threadId: string, action: ReviewAction, current: () => boolean) {
  const tool = /^(?:mcp__composio__|composio_)(.+)$/i.exec(action.tool)?.[1];
  if (!tool) return;
  for (const [key, grant] of connectorReviewGrants) if (grant.expiresAt <= Date.now()) connectorReviewGrants.delete(key);
  const expiresAt = Date.now() + 60_000;
  connectorReviewGrants.set(reviewGrantKey(threadId, tool, action.arguments),
    { settings: JSON.stringify(deps.config().approvalReview ?? {}), expiresAt, current: () => Date.now() < expiresAt && current() });
}

function approvedToolForTurn(botId: string, threadId: string, isCurrent: () => boolean) {
  return (action: ReviewAction, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error("The execution changed before approval could be used.");
    const tool = /^(?:mcp__composio__|composio_)(.+)$/i.exec(action.tool)?.[1];
    if (!tool || connectorReviewGrants.has(reviewGrantKey(threadId, tool, action.arguments))) return;
    carryConnectorApproval(threadId, action, authorizationCurrent(botId, threadId, isCurrent));
  };
}

function reviewToolForTurn(botId: string, threadId: string, session: ModelSelection, isCurrent: () => boolean) {
  const floorVerdict = (action: ReviewAction): ReviewVerdict | null => {
    const floor = automaticApprovalFloor(action);
    if (!floor) return null;
    const bot = deps.store().bot(botId);
    appendDecision(deps.dataDir, { threadId, botId, botName: bot?.name, tool: action.tool, summary: floor.reason,
      decision: floor.decision === "deny" ? "auto-denied" : "card-shown", source: "safety-floor", rule: floor.rule });
    deps.store().appendMessage(threadId, { role: "bot", kind: "activity",
      tool: { name: floor.reason, ok: floor.decision !== "deny" } });
    return { decision: floor.decision, reason: floor.reason };
  };
  return async (action: ReviewAction, signal: AbortSignal): Promise<ReviewVerdict> => {
    if (signal.aborted || !isCurrent()) return { decision: "ask", reason: "The execution changed before review." };
    const beforeReview = floorVerdict(action);
    if (beforeReview) return beforeReview;
    const settings = deps.config().approvalReview ?? {};
    let context: ReturnType<typeof authority>;
    let current: () => boolean;
    try { context = authority(botId, threadId); current = authorizationCurrent(botId, threadId, isCurrent); }
    catch { return { decision: "ask", reason: "The complete authorization evidence is unavailable; your approval is required." }; }
    const controller = new AbortController();
    const controllers = approvalReviewControllers.get(threadId) ?? new Set<AbortController>();
    controllers.add(controller);
    approvalReviewControllers.set(threadId, controllers);
    deps.watchdog().setCheckpointOwnsDeadline(threadId, true);
    try {
      deps.assertBudget();
      const bot = deps.store().bot(botId);
      if (!bot) return { decision: "ask", reason: "The requesting bot is no longer available." };
      const verdict = await reviewApproval({
        action, session: reviewSessionSelections.get(threadId) ?? session, settings, ...context,
        getProvider: deps.getProvider, providerRefusal: deps.providerRefusal,
        signal: AbortSignal.any([signal, controller.signal]), isCurrent: current,
        onUsage: (provider, usage) => deps.bookUsage({ botId, botName: bot.name, threadId: `approval-${threadId}-${randomUUID()}`,
          instanceId: provider.instanceId, driverKind: provider.driverKind, model: usage.model,
          input: usage.input ?? 0, output: usage.output ?? 0,
          ...(usage.cachedInput !== undefined ? { cachedInput: usage.cachedInput } : {}), costUsd: usage.costUsd ?? null,
          trigger: { kind: "bot", botId } }, usage.input !== undefined && usage.output !== undefined, threadId),
      });
      if (!current() || signal.aborted || controller.signal.aborted) return { decision: "ask", reason: "The execution changed while review was pending." };
      if (verdict.decision === "allow") {
        const beforeAllow = floorVerdict(action);
        if (beforeAllow) return beforeAllow;
      }
      const reason = redactSecretsInText(verdict.reason);
      appendDecision(deps.dataDir, { threadId, botId, botName: bot.name, tool: action.tool, summary: reason,
        decision: verdict.decision === "allow" ? "auto-approved" : verdict.decision === "deny" ? "auto-denied" : "card-shown",
        source: "auto-review", rule: verdict.reviewer ? `${verdict.reviewer.instanceId}:${verdict.reviewer.model}` : "review-unavailable" });
      deps.store().appendMessage(threadId, { role: "bot", kind: "activity",
        tool: { name: `${verdict.decision === "allow" ? "Approved" : verdict.decision === "deny" ? "Denied" : "Approval needed"} ${action.tool}: ${reason}`, ok: verdict.decision !== "deny" } });
      // A connector execution has an inner outbound gate. Carry only this
      // exact allow through it once, rather than calling the reviewer twice.
      if (verdict.decision === "allow") carryConnectorApproval(threadId, action, current);
      return { decision: verdict.decision, reason: verdict.decision === "deny"
        ? `${reason} Do not repackage this denied outcome or bypass review; use a materially safer alternative or ask the user.` : reason };
    } catch { return { decision: "ask", reason: "Automatic review is unavailable; your approval is required." }; }
    finally {
      controllers.delete(controller);
      if (!controllers.size) {
        approvalReviewControllers.delete(threadId);
        deps.watchdog().setCheckpointOwnsDeadline(threadId, false);
      }
    }
  };
}

  return {
    settingsBusy() {
      const store = deps.store();
      return approvalReviewControllers.size > 0 ||
        store.bots.some(bot => bot.tasks?.some(task => task.busy && deps.sourceApprovalMode(bot.id, task.threadId) === "auto")) ||
        store.groups.some(group => group.busyBotId && deps.roomApprovalMode(group.threadId, group.busyBotId) === "auto");
    },
    reviewToolForTurn, approvedToolForTurn, authorizationCurrent,
    setSession(threadId: string, session: ModelSelection) { reviewSessionSelections.set(threadId, session); },
    session(threadId: string) { return reviewSessionSelections.get(threadId); },
    updateSessionModel(threadId: string, model: string) {
      const selection = reviewSessionSelections.get(threadId);
      if (selection) reviewSessionSelections.set(threadId, { ...selection, model });
    },
    active() { return approvalReviewControllers.size; },
    takeConnectorGrant(threadId: string, tool: string, args: Record<string, unknown>) {
      const key = reviewGrantKey(threadId, tool, args);
      const grant = connectorReviewGrants.get(key);
      connectorReviewGrants.delete(key);
      return grant?.current() ? grant : undefined;
    },
    finishThread(threadId: string) {
      for (const controller of approvalReviewControllers.get(threadId) ?? []) controller.abort();
      reviewSessionSelections.delete(threadId);
      for (const key of connectorReviewGrants.keys()) if (key.startsWith(`${threadId}:`)) connectorReviewGrants.delete(key);
    },
  };
}
