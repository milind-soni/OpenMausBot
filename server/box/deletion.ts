// Box deletion journal — durable fences, provider operation receipts,
// reconciliation, and the credential check that gates Settings swaps.

import { retireDeletedBoxCreate } from "../box-create-idempotency.ts";
import {
  boxDeletionSnapshot,
  getBoxDeletion,
  hasPendingBoxDeletionForBot,
  markBoxDeletionAccepted,
  markBoxDeletionBlocked,
  prepareBoxDeletion,
  retireBoxDeletion,
  type BoxDeletionRecord,
} from "../box-delete-journal.ts";
import type { AppConfig } from "../config.ts";
import {
  boxErrorMessage,
  boxJson,
  forgetBoxId,
  inspectBoxIdentity,
  snapshotBoxConfig,
} from "./api.ts";

const BOX_DELETE_OPERATION_POLL_DELAYS_MS = [0, 100, 250, 500, 1_000, 2_000] as const;

const BOX_DELETE_OPERATION_ID = /^bdop_[a-f0-9]{32}$/;
const BOX_DELETE_OPERATION_STATES = new Set(["pending", "processing", "blocked", "completed"]);

interface BoxDeletionOperation {
  id: string;
  kind: "box";
  targetId: string;
  status: "pending" | "processing" | "blocked" | "completed";
}

/** Accept only the immutable identity fields needed to follow a delete. Any
 * malformed success envelope falls back to a direct Box read instead of
 * authorizing journal retirement. */
function boxDeletionOperation(
  body: any,
  boxId: string,
  expectedOperationId?: string,
): BoxDeletionOperation | null {
  const operation = body?.operation;
  const id = typeof operation?.id === "string" ? operation.id : "";
  const status = typeof operation?.status === "string" ? operation.status : "";
  if (
    !BOX_DELETE_OPERATION_ID.test(id)
    || (expectedOperationId !== undefined && id !== expectedOperationId)
    || operation?.kind !== "box"
    || operation?.targetId !== boxId
    || !BOX_DELETE_OPERATION_STATES.has(status)
  ) return null;
  return { id, kind: "box", targetId: boxId, status: status as BoxDeletionOperation["status"] };
}

function deletionBlockedError(boxId: string): Error & { status: number } {
  return Object.assign(
    new Error(`ascii.dev accepted deletion of ${boxId}, but the deletion operation is blocked — check ascii.dev and retry`),
    { status: 409 },
  );
}

function boxDeleteProvedAbsent(result: Awaited<ReturnType<typeof boxJson>>): boolean {
  return result.status === 404 || result.status === 410;
}

/** Retire the create receipt before the deletion fence. If that first durable
 * write fails, the fence remains and no caller can reuse a Box whose ownership
 * recovery is uncertain. */
function finishRecordedBoxDeletion(boxId: string): void {
  retireDeletedBoxCreate(boxId);
  forgetBoxId(boxId);
  retireBoxDeletion(boxId);
}

export type BoxDeletionReconciliation = "confirmed" | "pending" | "blocked";

/** Reconcile one durable deletion against the exact provider operation/Box.
 * Account LIST omission is never evidence: it is eventually consistent. */
export async function reconcileRecordedBoxDeletion(
  cfg: AppConfig,
  initial: BoxDeletionRecord,
  pollDelaysMs: readonly number[] = [],
): Promise<BoxDeletionReconciliation> {
  let record = initial;
  if (record.phase === "accepted" && record.status === "completed") {
    finishRecordedBoxDeletion(record.boxId);
    return "confirmed";
  }

  if (record.phase === "accepted" && record.operationId) {
    for (const delayMs of pollDelaysMs) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      let polled: Awaited<ReturnType<typeof boxJson>>;
      try {
        polled = await boxJson(cfg, `/deletion-operations/${record.operationId}`, {
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        break;
      }
      if (!polled.ok) break;
      const operation = boxDeletionOperation(polled.body, record.boxId, record.operationId);
      if (!operation) break;
      if (operation.status === "blocked") {
        record = markBoxDeletionBlocked(record.boxId, operation);
        break;
      }
      record = markBoxDeletionAccepted(record.boxId, operation);
      if (operation.status === "completed") {
        finishRecordedBoxDeletion(record.boxId);
        return "confirmed";
      }
    }
  }

  // A direct immutable-id 404/410 is the only alternate completion proof.
  // A live identity keeps the fence even when the operation endpoint is down.
  const inspected = await inspectBoxIdentity(cfg, record.boxId);
  if (!inspected.available) return record.phase === "blocked" ? "blocked" : "pending";
  if (!inspected.identity) {
    finishRecordedBoxDeletion(record.boxId);
    return "confirmed";
  }
  if (inspected.identity.name !== record.name) {
    throw Object.assign(
      new Error("A cloud computer being deleted no longer has its remembered name — repair it in ascii.dev before continuing"),
      { status: 503 },
    );
  }
  return record.phase === "blocked" ? "blocked" : "pending";
}

/** Prove that a replacement token can see every durable deletion target
 * before Settings swaps credentials. Unlike normal reconciliation, a bare
 * 404 is not completion proof here: it may simply be a different account. */
export async function verifyBoxDeletionCredential(cfg: AppConfig): Promise<void> {
  cfg = snapshotBoxConfig(cfg);
  for (const initial of boxDeletionSnapshot()) {
    let record = initial;
    let operationAuthorized = false;
    if (record.phase === "accepted" && record.operationId) {
      let polled: Awaited<ReturnType<typeof boxJson>> | null = null;
      try {
        polled = await boxJson(cfg, `/deletion-operations/${record.operationId}`, {
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        // The exact Box identity below can still prove account continuity.
      }
      if (polled?.ok) {
        const operation = boxDeletionOperation(polled.body, record.boxId, record.operationId);
        if (operation) {
          operationAuthorized = true;
          record = operation.status === "blocked"
            ? markBoxDeletionBlocked(record.boxId, operation)
            : markBoxDeletionAccepted(record.boxId, operation);
          if (operation.status === "completed") {
            finishRecordedBoxDeletion(record.boxId);
            continue;
          }
        }
      }
    }

    if (operationAuthorized) continue;

    const inspected = await inspectBoxIdentity(cfg, record.boxId);
    if (inspected.available && inspected.identity?.name === record.name) continue;
    if (!inspected.available) {
      throw Object.assign(
        new Error(`${inspected.problem ?? "a deleting cloud computer could not be verified"}. Retry with the Box account that owns it`),
        { status: 503 },
      );
    }
    throw Object.assign(
      new Error("that Box token cannot access the cloud computers whose deletion is still being reconciled"),
      { status: 409 },
    );
  }
}

/** Bind a successful DELETE response to the durable target before polling.
 * A malformed receipt leaves the prepared fence intact. */
async function confirmAcceptedBoxDeletion(
  cfg: AppConfig,
  record: BoxDeletionRecord,
  acceptedBody: any,
  pollDelaysMs: readonly number[] = BOX_DELETE_OPERATION_POLL_DELAYS_MS,
): Promise<BoxDeletionReconciliation> {
  const operation = boxDeletionOperation(acceptedBody, record.boxId);
  if (!operation) {
    const inspected = await inspectBoxIdentity(cfg, record.boxId);
    if (inspected.available && !inspected.identity) {
      finishRecordedBoxDeletion(record.boxId);
      return "confirmed";
    }
    throw Object.assign(
      new Error(`ascii.dev returned an invalid deletion receipt for ${record.boxId}; its deletion fence was kept`),
      { status: 503 },
    );
  }
  const next = operation.status === "blocked"
    ? markBoxDeletionBlocked(record.boxId, operation)
    : markBoxDeletionAccepted(record.boxId, operation);
  return reconcileRecordedBoxDeletion(cfg, next, pollDelaysMs);
}

/** Send (or explicitly retry) DELETE only after the immutable target is on
 * disk. The returned pending state always has a validated operation receipt. */
export async function requestRecordedBoxDeletion(
  cfg: AppConfig,
  identity: { boxId: string; name: string; ownerBotId: string | null },
  pollDelaysMs: readonly number[] = BOX_DELETE_OPERATION_POLL_DELAYS_MS,
): Promise<BoxDeletionReconciliation> {
  const deletion = prepareBoxDeletion(identity);
  let removed: Awaited<ReturnType<typeof boxJson>>;
  try {
    removed = await boxJson(cfg, `/boxes/${identity.boxId}`, {
      method: "DELETE",
      headers: { "X-Ascii-Confirm-Delete": identity.boxId },
    });
  } catch (error) {
    throw Object.assign(
      new Error("Could not confirm whether ascii.dev accepted the delete. The computer was kept fenced; retry Delete to reconcile it"),
      { status: 503, cause: error },
    );
  }
  if (boxDeleteProvedAbsent(removed)) {
    finishRecordedBoxDeletion(identity.boxId);
    return "confirmed";
  }
  if (!removed.ok) {
    markBoxDeletionBlocked(identity.boxId);
    throw Object.assign(new Error(boxErrorMessage(removed.status, "box delete", removed.body)), { status: removed.status });
  }
  const confirmation = await confirmAcceptedBoxDeletion(cfg, deletion, removed.body, pollDelaysMs);
  if (confirmation === "blocked") throw deletionBlockedError(identity.boxId);
  return confirmation;
}

export function deletionFenceError(): Error & { status: number } {
  return Object.assign(
    new Error("this cloud computer is being deleted — wait for it to finish, or retry Delete if it needs attention"),
    { status: 409 },
  );
}

export function assertBoxNotDeleting(boxId: string): void {
  if (getBoxDeletion(boxId)) throw deletionFenceError();
}

export function assertBotBoxNotDeleting(botId: string): void {
  if (hasPendingBoxDeletionForBot(botId)) throw deletionFenceError();
}
