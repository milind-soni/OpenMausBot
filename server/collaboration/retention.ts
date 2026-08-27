import type { DatabaseSync } from "node:sqlite";

import {
  type ContainmentBinding,
  type ContainmentPort,
  type ContainmentProof,
  verifyContainmentProof,
} from "./containment.ts";
import { assertCurrentInstanceLease, type InstanceLease, StaleFenceError } from "./leases.ts";
import { assertLedgerArmed } from "./restore-guard.ts";

export interface RetentionPolicy {
  successMs: number;
  failureOrCancellationMs: number;
}

export const DEFAULT_WORKTREE_RETENTION: RetentionPolicy = Object.freeze({
  successMs: 24 * 60 * 60_000,
  failureOrCancellationMs: 72 * 60 * 60_000,
});

export interface WorktreeCleanupPort {
  /** Must resolve paths against the configured managed root, not string-prefix check them. */
  isManagedPath(path: string): Promise<boolean>;
  /** Backend must reject an obsolete fence before doing destructive work. */
  remove(input: { path: string; instanceOwner: string; instanceFence: number }): Promise<void>;
}

interface RetainedRunRow {
  id: string;
  status: string;
  worktree_path: string;
  runtime_identity_json: string | null;
  containment_binding_json: string | null;
  containment_fingerprint: string | null;
  containment_state: string;
  retention_until: number | null;
  cleaned_at: number | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
}

function proof(value: string | null): ContainmentProof | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ContainmentProof;
  } catch {
    return null;
  }
}

function binding(value: string | null): ContainmentBinding | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ContainmentBinding;
  } catch {
    return null;
  }
}

export class WorktreeRetentionManager {
  private readonly database: DatabaseSync;
  private readonly containment: ContainmentPort;
  private readonly cleanup: WorktreeCleanupPort;
  private readonly policy: RetentionPolicy;

  constructor(
    database: DatabaseSync,
    containment: ContainmentPort,
    cleanup: WorktreeCleanupPort,
    policy: RetentionPolicy,
  ) {
    this.database = database;
    this.containment = containment;
    this.cleanup = cleanup;
    this.policy = policy;
    if (policy.successMs < 1 || policy.failureOrCancellationMs < policy.successMs) {
      throw new Error("Invalid worktree retention policy");
    }
  }

  schedule(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    runId: string,
    outcome: "success" | "failure" | "cancelled",
    now: number,
  ): number {
    assertCurrentInstanceLease(this.database, instance, now);
    assertLedgerArmed(this.database);
    const retentionUntil =
      now + (outcome === "success" ? this.policy.successMs : this.policy.failureOrCancellationMs);
    const updated = this.database
      .prepare(
        "UPDATE collaboration_runs SET retention_until = ?, version = version + 1 " +
          "WHERE id = ? AND cleaned_at IS NULL",
      )
      .run(retentionUntil, runId);
    if (updated.changes !== 1) throw new Error(`Unknown or already-cleaned run: ${runId}`);
    return retentionUntil;
  }

  async cleanupExpired(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    now: number,
  ): Promise<Array<{ runId: string; cleaned: boolean; reason: string }>> {
    assertCurrentInstanceLease(this.database, instance, now);
    assertLedgerArmed(this.database);
    const rows = this.database
      .prepare(
        "SELECT r.id, r.status, r.worktree_path, r.runtime_identity_json, r.containment_binding_json, " +
          "r.containment_fingerprint, r.containment_state, " +
          "r.retention_until, r.cleaned_at, n.lease_owner, n.lease_expires_at " +
          "FROM collaboration_runs r LEFT JOIN collaboration_work_nodes n " +
          "ON n.work_item_id = r.work_item_id AND n.plan_revision = r.plan_revision AND n.node_id = r.node_id " +
          "WHERE r.cleaned_at IS NULL AND r.retention_until IS NOT NULL AND r.retention_until <= ? " +
          "ORDER BY r.retention_until, r.id",
      )
      .all(now) as unknown as RetainedRunRow[];
    const results: Array<{ runId: string; cleaned: boolean; reason: string }> = [];
    for (const row of rows) results.push(await this.cleanupOne(instance, row, now));
    return results;
  }

  private async cleanupOne(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    row: RetainedRunRow,
    now: number,
  ): Promise<{ runId: string; cleaned: boolean; reason: string }> {
    if (row.lease_owner && row.lease_expires_at && row.lease_expires_at > now) {
      return { runId: row.id, cleaned: false, reason: "node_lease_active" };
    }
    const audit = this.database
      .prepare("SELECT 1 FROM collaboration_audit_events WHERE run_id = ? LIMIT 1")
      .get(row.id);
    if (!audit) return { runId: row.id, cleaned: false, reason: "evidence_not_durable" };
    if (row.status === "succeeded") {
      const candidate = this.database
        .prepare("SELECT state FROM collaboration_candidates WHERE run_id = ?")
        .get(row.id) as { state: string } | undefined;
      if (!candidate) return { runId: row.id, cleaned: false, reason: "candidate_not_durable" };
      if (candidate.state === "target_tests_passed" || candidate.state === "test_failed") {
        const evidence = this.database
          .prepare("SELECT 1 FROM collaboration_test_evidence WHERE run_id = ? LIMIT 1")
          .get(row.id);
        if (!evidence) return { runId: row.id, cleaned: false, reason: "test_evidence_not_durable" };
      }
    }
    if (!(await this.cleanup.isManagedPath(row.worktree_path))) {
      return { runId: row.id, cleaned: false, reason: "worktree_not_managed" };
    }
    const runtimeProof = proof(row.runtime_identity_json);
    const runtimeBinding = binding(row.containment_binding_json);
    if (!runtimeBinding) return { runId: row.id, cleaned: false, reason: "containment_binding_missing" };
    const verified = await verifyContainmentProof(this.containment, runtimeProof, runtimeBinding);
    if (!verified.verified || !runtimeProof || verified.fingerprint !== row.containment_fingerprint) {
      return {
        runId: row.id,
        cleaned: false,
        reason: "reason" in verified ? verified.reason : "containment_proof_missing",
      };
    }
    const inspected = await this.containment.inspect(runtimeProof.identity);
    if (inspected.state !== "empty" || inspected.fingerprint !== verified.fingerprint) {
      return {
        runId: row.id,
        cleaned: false,
        reason: inspected.state === "unknown" ? inspected.reason : "containment_not_empty",
      };
    }
    assertCurrentInstanceLease(this.database, instance, now);
    await this.cleanup.remove({
      path: row.worktree_path,
      instanceOwner: instance.ownerId,
      instanceFence: instance.fence,
    });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, now);
      const updated = this.database
        .prepare(
          "UPDATE collaboration_runs SET cleaned_at = ?, containment_state = 'empty', version = version + 1 " +
            "WHERE id = ? AND cleaned_at IS NULL AND retention_until <= ?",
        )
        .run(now, row.id, now);
      if (updated.changes !== 1) throw new StaleFenceError("Retention cleanup result is stale");
      this.database.exec("COMMIT");
      return { runId: row.id, cleaned: true, reason: "retention_elapsed" };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
