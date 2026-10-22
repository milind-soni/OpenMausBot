// Nothing here decides whether an action is safe: each level is the provider's own permission mode passed through, and a
// request reaching this process is one the provider left for a person. The app's own grants are Full access, the person's
// exact saved commands and remembered MCP read tools, and Approve for me's web search. A bot's question always reaches a human.

import { supportsApprovalMode, type ApprovalMode } from "../shared/approval-mode.ts";
import { failedTurnTool, type FailedTurnTool } from "../shared/failed-turn.ts";
import { isOutboundTool } from "../shared/outbound.ts";
import type { ProviderAdapter, RequestOutcome } from "./contracts.ts";

/** An expired ask must never become a fresh Allow/Deny card. */
export async function deliverFullAccessApproval(
  adapter: Pick<ProviderAdapter, "respondToRequest" | "interruptTurn"> | undefined,
  threadId: string,
  requestId: string,
  turnId?: string,
  isCurrent: () => boolean = () => false,
): Promise<RequestOutcome | "failed"> {
  if (!adapter) return "failed";
  try {
    return await adapter.respondToRequest(threadId, requestId, { behavior: "allow" });
  } catch {
    // Some adapters ignore the native turn id, so recheck the owning generation before interrupting.
    if (turnId && isCurrent()) await adapter.interruptTurn(threadId, turnId).catch(() => {});
    return "failed";
  }
}

/** Full access is the person's grant to this receiving bot: never inherited from a sender (delegatedApprovalMode aside), and
 * peer-started Custom turns run as Auto. */
export function approvalModeForOrigin(mode: ApprovalMode, origin: { peerInitiated: boolean }): ApprovalMode {
  if (mode === "custom" && origin.peerInitiated) return "auto";
  return mode;
}

/** Custom is a provider config of its own and is never compared. */
const LEVEL_RANK: Partial<Record<ApprovalMode, number>> = { ask: 0, edits: 1, auto: 2, full: 3 };

/** A Chief of Staff's level flows down: only a Chief's, only from the conversation it delegates from, only upward, and capped
 * at what the teammate's engine implements. A bot never raises itself this way; null keeps the teammate's own. */
export function delegatedApprovalMode(input: {
  senderIsChief: boolean;
  senderMode: ApprovalMode;
  sameBot: boolean;
  recipientMode: ApprovalMode;
  recipientDriverKind: string | undefined;
}): ApprovalMode | null {
  if (!input.senderIsChief || input.sameBot) return null;
  // A Chief's Custom reads as Approve for me for a teammate, like any peer-started Custom turn.
  const sender = LEVEL_RANK[approvalModeForOrigin(input.senderMode, { peerInitiated: true })] ?? 0;
  const own = LEVEL_RANK[input.recipientMode];
  if (own === undefined) return null;
  for (const mode of ["full", "auto", "edits"] as const) {
    const rank = LEVEL_RANK[mode]!;
    if (rank > sender) continue;
    if (rank <= own) return null;
    if (supportsApprovalMode(input.recipientDriverKind, mode)) return mode;
  }
  return null;
}

// Tools that ask a person: a malformed AskUserQuestion falls back to the permission path, and approving it runs the tool with
// no answer ("The user did not answer the questions."), so no mode may answer one.
const ASKS_A_PERSON = new Set(["askuserquestion", "ask_user"]);

// Approve for me allows these names and nothing wider: a page fetch and every other tool stay a prompt.
const WEB_SEARCH = new Set(["websearch", "web_search", "web-search", "search_web"]);

function bareToolName(tool: string): string {
  return tool.replace(/^mcp__[^_]+__/, "").toLowerCase();
}

/** The decision log's "which rule": `full-access` and `command-allowlist` are user grants, `web-search` Approve for me's own,
 * `native-approval` a card the provider's reviewer left, `explicit-approval-block` a sandbox widening only Full may answer. */
export type AutoVerdictSource =
  | "full-access"
  | "command-allowlist"
  | "tool-allowlist"
  | "web-search"
  | "native-approval"
  | "explicit-approval-block"
  | "outbound-guard"
  | "safety-floor"
  | "no-grant";

export interface AutoVerdict {
  /** The chip text when the app answers, so an auto-approved action is never invisible; null when a human decides. */
  approve: string | null;
  source: AutoVerdictSource;
}

export function autoVerdict(
  mode: ApprovalMode,
  tool: string,
  context?: {
    /** The provider asks to widen its sandbox rather than perform one action; only explicit Full may answer. */
    requiresExplicitApproval?: boolean;
    /** Exact bot/provider/folder/command match against the person's saved rules. */
    commandAllowed?: boolean;
    /** Exact provider/server/tool/config match against a person's saved MCP read grant. */
    toolAllowed?: boolean;
  },
): AutoVerdict {
  if (ASKS_A_PERSON.has(bareToolName(tool))) {
    return { approve: null, source: "no-grant" };
  }
  // Full's promise is literal, sandbox widening included; entering Full is consent-gated by the bot PATCH endpoint.
  if (mode === "full") return { approve: `approved ${tool} (full access)`, source: "full-access" };
  if (context?.requiresExplicitApproval) return { approve: null, source: "explicit-approval-block" };
  if (isOutboundTool(tool)) return { approve: null, source: "outbound-guard" };
  if (context?.commandAllowed) return { approve: `approved ${tool} (saved command)`, source: "command-allowlist" };
  if (context?.toolAllowed) return { approve: `approved ${tool} (always allowed)`, source: "tool-allowlist" };
  if (mode === "auto" && WEB_SEARCH.has(bareToolName(tool))) {
    return { approve: `approved ${tool} (web search)`, source: "web-search" };
  }
  if (mode === "auto" || mode === "custom") return { approve: null, source: "native-approval" };
  return { approve: null, source: "no-grant" };
}

/** `unavailable` and `allowed-once` have no transcript row, so callers do not ask for one. */
export function undeliveredApprovalTool(
  outcome: Exclude<RequestOutcome, "allowed-once" | "unavailable"> | "failed",
  source: AutoVerdictSource,
): FailedTurnTool | { name: string; ok: false } {
  if (outcome !== "rejected") return failedTurnTool("could not deliver approval to the provider; retry the task after reconnecting.");
  const grant = source === "command-allowlist" ? "the saved command permission"
    : source === "tool-allowlist" ? "the saved tool permission" : "Full access";
  return { name: `The provider rejected this action despite ${grant}.`, ok: false };
}

/** The client translates by key and falls back to this text, which the server keeps sending for older cards. */
export const HELD_NOTE = {
  "approval.held.outbound": "This sends something on your behalf, so it asks you first.",
  "approval.held.native": "The provider requires your approval for this action.",
  "approval.held.sandbox":
    "This loosens the AI's own safety limits, so only Full access can approve it automatically.",
  "approval.held.undeliveredFull": "Full access couldn't deliver this approval.",
  "approval.held.undelivered": "Approve for me couldn't answer this one.",
} as const;

export type HeldNoteKey = keyof typeof HELD_NOTE;

export function approvalHeldNote(context: {
  source?: AutoVerdictSource;
  permission: boolean;
}): HeldNoteKey | undefined {
  if (!context.permission) return undefined;
  if (context.source === "outbound-guard") return "approval.held.outbound";
  if (context.source === "explicit-approval-block") return "approval.held.sandbox";
  if (context.source === "native-approval") return "approval.held.native";
  return undefined;
}

export function approvalHeldReason(context: {
  source?: AutoVerdictSource;
  permission: boolean;
}): string | undefined {
  const key = approvalHeldNote(context);
  return key && HELD_NOTE[key];
}
