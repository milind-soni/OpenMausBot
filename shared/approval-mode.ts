/** The four approval levels exposed by the desktop app. */
export const APPROVAL_MODES = ["ask", "auto", "full", "custom"] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

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
