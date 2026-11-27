// Boat's deletion operation: DELETE /sandboxes/{id} answers 202 with one, polled at GET /deletion-operations/{id}
// (https://docs.boat.dev/data-retention/delete, https://docs.boat.dev/api/reference/account/get-deletion-operation).
// The sandbox leaves every list, restore and fork at once, a delete can never be cancelled, and Boat retries the purge
// itself, so `blocked` is not a failure: it says what the background erase waits for.

const OPERATION_ID = /^bdop_[a-f0-9]{32}$/;
const STATUSES = new Set(["pending", "processing", "blocked", "completed"]);

/** Boat finishes these on its own: at `expectedBy` once the last upload link expires (≤ 6 h after the last upload), after a
 * restore that reads the data ends, or on Boat's own retry. */
const SELF_FINISHING_STAGES = new Set(["removing", "waiting_for_uploads", "waiting_for_restore", "retrying", "completed"]);

export interface BoatDeletionOperation {
  id: string;
  kind: "sandbox";
  targetId: string;
  status: "pending" | "processing" | "blocked" | "completed";
  /** removing, waiting_for_uploads, kept_for_newer_snapshots, waiting_for_restore, retrying, completed */
  stage: string | null;
}

/** Only the immutable identity fields; a malformed success envelope falls back to a direct read, never journal retirement. */
export function boatDeletionOperation(
  body: any,
  boxId: string,
  expectedOperationId?: string,
): BoatDeletionOperation | null {
  const operation = body?.operation;
  const id = typeof operation?.id === "string" ? operation.id : "";
  const status = typeof operation?.status === "string" ? operation.status : "";
  if (
    !OPERATION_ID.test(id)
    || (expectedOperationId !== undefined && id !== expectedOperationId)
    || operation?.kind !== "sandbox"
    || operation?.targetId !== boxId
    || !STATUSES.has(status)
  ) return null;
  const stage = typeof operation.stage === "string" ? operation.stage : null;
  return { id, kind: "sandbox", targetId: boxId, status: status as BoatDeletionOperation["status"], stage };
}

/** Blocked only until Boat finishes on its own: OpenMausBot's delete is done. */
export const blockedUntilBoatFinishes = (operation: BoatDeletionOperation) =>
  operation.status === "blocked" && SELF_FINISHING_STAGES.has(operation.stage ?? "");

/** Blocked until the person deletes a fork or named snapshot that still builds on the data. */
export const keptForNewerSnapshots = (operation: BoatDeletionOperation) =>
  operation.status === "blocked" && operation.stage === "kept_for_newer_snapshots";

/** Never "retry": Boat accepted the delete and retries the purge itself. */
export function deletionBlockedError(boxId: string, kept: boolean): Error & { status: number } {
  return Object.assign(new Error(kept
    ? `boat.dev deleted cloud computer ${boxId} but is keeping its stored data, because a fork or named snapshot made from it still uses that data. To erase the data, delete those in boat.dev.`
    : `boat.dev accepted the deletion of cloud computer ${boxId}, but says it is blocked without a reason OpenMausBot knows. boat.dev keeps retrying on its own; if ${boxId} is still listed in boat.dev later, delete it there.`,
  ), { status: 409 });
}
