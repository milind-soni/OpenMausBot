/** The approval levels exposed by the app. Each one is a provider's own
 * permission mode, passed through: OpenMausBot never decides a permission
 * itself (Full access aside, which answers residual prompts because that is
 * what the person granted). The order is the order the selector shows. */
export const APPROVAL_MODES = ["ask", "edits", "auto", "full", "custom"] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Only providers with an implemented permission mapping may expose a level.
 * `edits` (auto-accept edits) exists where the engine has such a mode:
 * Claude and Grok `acceptEdits`, Antigravity `auto_edit`. Codex's Ask already
 * runs `workspace-write`, so an edits level would change nothing there. */
export function supportsApprovalMode(driverKind: string | undefined, mode: ApprovalMode): boolean {
  if (mode === "custom") return driverKind === "codex";
  if (mode === "edits") return ["claudeAgent", "grokAgent", "antigravityAgent"].includes(driverKind ?? "");
  if (mode !== "full") return true;
  return ["codex", "claudeAgent", "antigravityAgent", "cursorAgent", "grokAgent", "opencodeGo"].includes(driverKind ?? "");
}

export function hasNativeAutoReview(driverKind: string | undefined): boolean {
  return ["codex", "claudeAgent", "cursorAgent", "grokAgent"].includes(driverKind ?? "");
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

/** Resolve the durable mode without turning the legacy Auto bit into Full
 * access. Records written before approvalMode existed keep their exact old
 * behavior: autoApprove=true is safe Auto; everything else asks. Unknown
 * persisted values also fail closed to that legacy behavior. */
export function approvalModeFor(bot: {
  approvalMode?: unknown;
  autoApprove?: unknown;
  /** Server-only two-phase grant marker. Until Electron confirms it, the
   * stored elevated selection is deliberately executable only as Ask. */
  approvalGrant?: unknown;
}): ApprovalMode {
  if (bot.approvalGrant) return "ask";
  if (isApprovalMode(bot.approvalMode)) return bot.approvalMode;
  return bot.autoApprove === true ? "auto" : "ask";
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
