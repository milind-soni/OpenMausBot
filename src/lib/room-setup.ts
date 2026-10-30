import type { Group } from "@/state/store";

type RoomSetupFields = {
  setupPending?: boolean;
  setupRequired?: boolean;
  setupState?: "required" | "completed" | "skipped";
  setupCompletedAt?: number | string | null;
  setupSkippedAt?: number | string | null;
};

/** A new room shows its setup until the server records it as completed or skipped. */
export function roomNeedsSetup(group: Group): boolean {
  if (group.dm || group.messages.length > 0) return false;
  // SAFETY: setup fields are additive server metadata; the existing Group shape remains valid when absent.
  const marker = group as Group & RoomSetupFields;
  const hasSetupMarker =
    Object.prototype.hasOwnProperty.call(marker, "setupCompletedAt") ||
    Object.prototype.hasOwnProperty.call(marker, "setupSkippedAt");
  if (!hasSetupMarker) return false;
  if (
    marker.setupPending === false ||
    marker.setupRequired === false ||
    marker.setupState === "completed" ||
    marker.setupState === "skipped" ||
    marker.setupCompletedAt != null ||
    marker.setupSkippedAt != null
  ) {
    return false;
  }
  return true;
}
