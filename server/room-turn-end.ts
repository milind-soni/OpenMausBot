/** How a room member's provider turn ended, read from its turn.completed and
 * from what ended it early: the member's cloud computer, claimed by its first
 * computer call, could not start (a failure with its cause) or parked waiting
 * for its seat. Kept free of index.ts so the rule stays unit-testable. */

/** What ended a member's turn early, set by its claim's rejection. */
export type RoomClaimEnd = { parked: true } | { parked: false; message: string };

export function roomTurnEnd(
  event: { ok: boolean; stopReason?: string | null },
  orchestrated: boolean,
  claim?: RoomClaimEnd,
): { outcome: "settled" | "provider_failed" | "parked"; stopReason?: string | null } {
  if (claim?.parked) return { outcome: "parked" };
  // The cause, not the "interrupted" the ending interrupt settles as; and a
  // chat round stops here, as it stops on a failure at setup.
  if (claim) return { outcome: "provider_failed", stopReason: claim.message };
  if (orchestrated && !event.ok) return { outcome: "provider_failed", stopReason: event.stopReason ?? null };
  return { outcome: "settled" };
}
