/** The four approval levels exposed by the desktop app. */
export const APPROVAL_MODES = ["ask", "auto", "full", "custom"] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Only providers with an implemented permission mapping may expose elevation. */
export function supportsApprovalMode(driverKind: string | undefined, mode: ApprovalMode): boolean {
  if (mode === "custom") return driverKind === "codex";
  if (mode !== "full") return true;
  return ["codex", "claudeAgent", "antigravityAgent", "cursorAgent", "grokAgent", "opencodeGo"].includes(driverKind ?? "");
}

export function hasNativeAutoReview(driverKind: string | undefined): boolean {
  return ["codex", "claudeAgent", "cursorAgent"].includes(driverKind ?? "");
}

/** A native reviewer has already declined to decide, or Auto has no native
 * equivalent. Never second-guess that request with the app's heuristic rules.
 * OpenCode's Full mode is implemented by approving individual ACP requests. */
export function requiresNativeApproval(driverKind: string, mode: ApprovalMode): boolean {
  return mode === "auto" || (mode === "full" && ["claudeAgent", "antigravityAgent", "cursorAgent", "grokAgent"].includes(driverKind));
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
