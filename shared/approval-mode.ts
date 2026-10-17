/** The approval levels exposed by the app. Each one is a provider's own
 * permission mode, passed through: OpenMausBot never decides a permission
 * itself (Full access aside, which answers residual prompts because that is
 * what the person granted). The order is the order the selector shows. */
export const APPROVAL_MODES = ["ask", "edits", "auto", "full", "custom"] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Only providers with an implemented permission mapping may expose a level.
 * `edits` (auto-accept edits) exists where the engine has such a mode:
 * Claude and Grok `acceptEdits`, Antigravity `auto_edit`, Qwen `auto-edit`,
 * Gemini `auto_edit`. Codex's Ask already runs `workspace-write`, so an edits
 * level would change nothing there. Full access, the default level, runs on
 * every engine: in the engine's own most permissive mode, or, where it has
 * none, with the harness answering the permission requests it leaves (the
 * chat-completions family, ACP agents such as Kimi or Hermes, Pi's computer
 * confirms). */
export function supportsApprovalMode(driverKind: string | undefined, mode: ApprovalMode): boolean {
  if (mode === "custom") return driverKind === "codex";
  if (mode === "edits") return ["claudeAgent", "grokAgent", "antigravityAgent", "qwenAgent", "geminiAgent"].includes(driverKind ?? "");
  return true;
}

/** Whether switching engines must first drop this level to Ask. A Custom
 * grant's rules belong to one provider's tool semantics, so it never crosses
 * engines; Full carries silently to any engine; Auto-accept edits stops at an
 * engine without it.
 * Adapted from tahodev's provider-switch guard. */
export function modelSwitchNeedsAsk(
  mode: ApprovalMode,
  fromDriver: string | undefined,
  toDriver: string | undefined,
): boolean {
  return !supportsApprovalMode(toDriver, mode) || (mode === "custom" && fromDriver !== toDriver);
}

export function hasNativeAutoReview(driverKind: string | undefined): boolean {
  // Qwen Code's `--approval-mode auto` is an LLM classifier that approves
  // safe actions and blocks risky ones — a reviewer, not a rubber stamp.
  return ["codex", "claudeAgent", "cursorAgent", "grokAgent", "qwenAgent"].includes(driverKind ?? "");
}

const APPROVAL_RANK: Record<ApprovalMode, number> = { ask: 0, edits: 1, auto: 2, full: 3, custom: 4 };

export function approvalModeWidens(from: ApprovalMode, to: ApprovalMode): boolean {
  return APPROVAL_RANK[to] > APPROVAL_RANK[from];
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

/** The level a bot or conversation runs at until a person picks one: Full
 * access, as in t3code (its DEFAULT_RUNTIME_MODE). Each provider maps it to
 * its own most permissive mode; a real question or a missing credential
 * still reaches a person. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "full";

let defaultApprovalMode: ApprovalMode = DEFAULT_APPROVAL_MODE;

/** On a shared company workspace Full access comes only from the operator's
 * own policy, so its server makes Ask the default once, at startup. */
export function setDefaultApprovalMode(mode: ApprovalMode): void {
  defaultApprovalMode = mode;
}

/** An unset level runs at the default, the pre-approvalMode Auto bit reads as
 * safe Auto, and an unknown persisted value fails closed to Ask. */
export function approvalModeFor(bot: {
  approvalMode?: unknown;
  autoApprove?: unknown;
  /** Server-only two-phase grant marker. Until Electron confirms it, the
   * stored elevated selection is deliberately executable only as Ask. */
  approvalGrant?: unknown;
  threadId?: string;
}): ApprovalMode {
  const grant = bot.approvalGrant;
  const otherThread = grant && typeof grant === "object" && "threadOnly" in grant && grant.threadOnly === true &&
    "threadId" in grant && typeof grant.threadId === "string" && typeof bot.threadId === "string" && grant.threadId !== bot.threadId;
  if (grant && !otherThread) return "ask";
  if (isApprovalMode(bot.approvalMode)) return bot.approvalMode;
  if (bot.autoApprove === true) return "auto";
  return bot.approvalMode === undefined ? defaultApprovalMode : "ask";
}

/** A private late-grant recovery may revoke an elevated mode even after a
 * turn began. It can only move to the fail-closed Ask mode; ordinary changes
 * remain blocked while the bot is working. */
export function isEmergencyApprovalDowngrade(
  current: ApprovalMode,
  next: ApprovalMode,
): boolean {
  return next === "ask" && (current === "full" || current === "custom");
}

/** The level a thread takes when it moves back onto its bot's model and its own level would need
 * confirming on that engine: the bot's own saved level there, instead of Ask. Null (Ask, as before)
 * when the bot's level is Ask, still a pending grant, or one the engine does not implement. A
 * thread-only grant belongs to its one thread, so it is not the bot's level. */
export function botLevelOnItsEngine(
  bot: { approvalMode?: unknown; autoApprove?: unknown; approvalGrant?: { threadOnly?: true } | null; alwaysAllow?: string[] },
  driverKind: string | undefined,
): { approvalMode: ApprovalMode; autoApprove: boolean; alwaysAllow: string[] } | null {
  const mode = approvalModeFor({ approvalMode: bot.approvalMode, autoApprove: bot.autoApprove, approvalGrant: bot.approvalGrant?.threadOnly ? undefined : bot.approvalGrant });
  if (mode === "ask" || !supportsApprovalMode(driverKind, mode)) return null;
  return { approvalMode: mode, autoApprove: mode === "auto", alwaysAllow: [...(bot.alwaysAllow ?? [])] };
}
