import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface RestoreGuardState {
  state: "live" | "review_required";
  sourceBackupHash: string | null;
  restoredAt: number | null;
  version: number;
}

export function readRestoreGuard(database: DatabaseSync): RestoreGuardState {
  const row = database
    .prepare(
      "SELECT state, source_backup_hash, restored_at, version FROM collaboration_restore_guard WHERE singleton = 1",
    )
    .get() as {
    state: RestoreGuardState["state"];
    source_backup_hash: string | null;
    restored_at: number | null;
    version: number;
  };
  return {
    state: row.state,
    sourceBackupHash: row.source_backup_hash,
    restoredAt: row.restored_at,
    version: row.version,
  };
}

export function assertLedgerArmed(database: DatabaseSync): void {
  if (readRestoreGuard(database).state !== "live") throw new Error("restore_review_required");
}

export function markRestoredLedgerForReview(
  database: DatabaseSync,
  backupArtifact: Buffer,
  now: number,
): string {
  const hash = createHash("sha256").update(backupArtifact).digest("hex");
  const changed = database
    .prepare(
      "UPDATE collaboration_restore_guard SET state = 'review_required', source_backup_hash = ?, restored_at = ?, " +
        "rearmed_at = NULL, rearmed_by = NULL, version = version + 1 WHERE singleton = 1 AND state = 'live'",
    )
    .run(hash, now);
  if (changed.changes !== 1) throw new Error("restore_guard_transition_failed");
  return hash;
}
