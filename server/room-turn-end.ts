export type RoomClaimEnd = { parked: true } | { parked: false; message: string };

export function roomTurnEnd(
  event: { ok: boolean; stopReason?: string | null },
  orchestrated: boolean,
  claim?: RoomClaimEnd,
): { outcome: "settled" | "provider_failed" | "parked"; stopReason?: string | null } {
  if (claim?.parked) return { outcome: "parked" };
  if (claim) return { outcome: "provider_failed", stopReason: claim.message };
  if (orchestrated && !event.ok) return { outcome: "provider_failed", stopReason: event.stopReason ?? null };
  return { outcome: "settled" };
}
