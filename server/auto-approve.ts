// What the harness does with a provider's permission request.
//
// Nothing here decides whether an action is safe. Each approval level is a
// provider's own permission mode passed straight through (Claude `auto`,
// Grok `--permission-mode`, Codex `approvalsReviewer`, …), and a request that
// reaches this process is one the provider left for a person. The only
// verdict the app synthesizes is Full access, because that level is the
// person's explicit, separately confirmed grant to answer every prompt.
// Questions never come through here: a bot's question always reaches a human.

import { supportsApprovalMode, type ApprovalMode } from "../shared/approval-mode.ts";
import type { ProviderAdapter, RequestOutcome } from "./contracts.ts";

/** A failed delivery is a runtime error, not another permission decision.
 * An expired ask must never become a fresh Allow/Deny card. */
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
    // Some adapters ignore the optional native turn id. Recheck the
    // server's owning generation before interrupting that thread.
    if (turnId && isCurrent()) await adapter.interruptTurn(threadId, turnId).catch(() => {});
    return "failed";
  }
}

/** Full access is the person's explicit grant to this receiving bot, including
 * delegated work. It never inherits the sender's mode or elevates another bot
 * — with the one exception below (delegationInheritsFullAccess), applied
 * where a Chief's delegated thread is created rather than here.
 * Custom is a provider-config choice rather than an app Full-access grant, so
 * peer-started Custom turns use Auto. Provider support and grant confirmation
 * are checked by the caller. */
export function approvalModeForOrigin(mode: ApprovalMode, origin: { peerInitiated: boolean }): ApprovalMode {
  if (mode === "custom" && origin.peerInitiated) return "auto";
  return mode;
}

/** Whether work a bot hands to a teammate runs with Full access. Only a Chief
 * of Staff passes access on, and only the Full access the person gave it for
 * the conversation it is delegating from: the Chief exists to get the team's
 * work done without the person answering every card, and a teammate stopping
 * that work to ask defeats the grant. The recipient's engine has to implement
 * Full, or the work keeps the recipient's own level. A bot never elevates
 * itself this way. */
export function delegationInheritsFullAccess(input: {
  senderIsChief: boolean;
  senderHasFullAccess: boolean;
  sameBot: boolean;
  recipientDriverKind: string | undefined;
}): boolean {
  return input.senderIsChief && input.senderHasFullAccess && !input.sameBot
    && supportsApprovalMode(input.recipientDriverKind, "full");
}

// Tools that ask a PERSON something. A question exists so that a human
// decides; any mode answering one on their behalf defeats the only reason
// it was asked. They normally arrive typed as questions and never reach a
// verdict at all — this is the backstop for the path where one arrives
// mis-typed as a permission (a malformed AskUserQuestion call falls back to
// the permission path in permission-proxy). Approving it there does not
// produce an answer: the CLI runs the tool with none and the model is told
// "The user did not answer the questions." — a question silently lost.
const ASKS_A_PERSON = new Set(["askuserquestion", "ask_user"]);

/** Why a permission request landed where it did — the decision log's "which
 * rule". `full-access` is the one auto-approval; `native-approval` is a card
 * the provider's own reviewer (Auto, or Custom's config) left for the person;
 * `explicit-approval-block` is a sandbox widening only Full may answer;
 * `no-grant` is an Ask or Edits card, where asking is the whole point. */
export type AutoVerdictSource =
  | "full-access"
  | "native-approval"
  | "explicit-approval-block"
  | "no-grant";

export interface AutoVerdict {
  /** Chip text when the app answers for the person, null when a human
   * decides. The string becomes the chip in the transcript, so an
   * auto-approved action is never invisible. */
  approve: string | null;
  source: AutoVerdictSource;
}

export function autoVerdict(
  mode: ApprovalMode,
  tool: string,
  context?: {
    /** The provider is asking to widen its configured sandbox rather than
     * perform one ordinary action. Only explicit Full may synthesize this. */
    requiresExplicitApproval?: boolean;
  },
): AutoVerdict {
  // A question is for a person, whatever channel it arrived on — and
  // whatever the mode: even Full has no answer to give, only an approval
  // that would run the tool with none.
  if (ASKS_A_PERSON.has(tool.replace(/^mcp__[^_]+__/, "").toLowerCase())) {
    return { approve: null, source: "no-grant" };
  }
  // Full's promise is literal: even a sandbox widening is approved. Entering
  // Full is separately consent-gated by the bot PATCH endpoint, and the
  // request.opened caller invokes this for permissions only, never questions.
  if (mode === "full") return { approve: `approved ${tool} (full access)`, source: "full-access" };
  if (context?.requiresExplicitApproval) return { approve: null, source: "explicit-approval-block" };
  if (mode === "auto" || mode === "custom") return { approve: null, source: "native-approval" };
  return { approve: null, source: "no-grant" };
}

/** Every fixed note a held card can show, by catalog key.
 *
 * The card is the last thing between a bot and someone's filesystem, so the
 * one line explaining why it stopped should not be the one line still in
 * English. The client translates by key and falls back to this text, which
 * the server keeps sending: cards saved before the key existed still render,
 * and so do the free-text apply errors that have no key at all. */
export const HELD_NOTE = {
  "approval.held.native": "The provider requires your approval for this action.",
  "approval.held.sandbox":
    "This changes the provider sandbox, so only Full access can approve it automatically.",
  "approval.held.undeliveredFull": "Full access couldn't deliver this approval.",
  "approval.held.undelivered": "Approve for me couldn't answer this one.",
} as const;

export type HeldNoteKey = keyof typeof HELD_NOTE;

/** Which note, as a key. approvalHeldReason is this plus the English text, so
 * the branching that decides the note lives in exactly one place. */
export function approvalHeldNote(context: {
  source?: AutoVerdictSource;
  /** Questions are not permissions and are never held for a mode reason. */
  permission: boolean;
}): HeldNoteKey | undefined {
  if (!context.permission) return undefined;
  if (context.source === "explicit-approval-block") return "approval.held.sandbox";
  if (context.source === "native-approval") return "approval.held.native";
  return undefined;
}

/** The note a card shows above its buttons, explaining why the bot stopped
 * rather than answering for itself. */
export function approvalHeldReason(context: {
  source?: AutoVerdictSource;
  permission: boolean;
}): string | undefined {
  const key = approvalHeldNote(context);
  return key && HELD_NOTE[key];
}
