import type { DatabaseSync } from "node:sqlite";

import {
  type ContainmentPort,
  type ContainmentProof,
  runtimeIdentityFingerprint,
  verifyContainmentProof,
} from "./containment.ts";
import { assertCurrentInstanceLease, type InstanceLease } from "./leases.ts";

export type RecoveryClassification =
  | "resumable"
  | "candidate_produced"
  | "interrupted"
  | "unsafe_to_retry"
  | "needs_configuration";

export interface RecoveryDecision {
  runId: string;
  classification: RecoveryClassification;
  nextAction: "reattach" | "deterministic_validation" | "retry" | "none";
  reason: string;
}

export interface CandidateInspectionPort {
  inspect(input: {
    runId: string;
    worktreePath: string;
    baseSha: string;
    recordedResultSha: string | null;
  }): Promise<{ complete: boolean; resultSha: string | null; reason?: string }>;
}

interface RecoverableRunRow {
  id: string;
  work_item_id: string;
  plan_revision: number;
  node_id: string;
  attempt: number;
  worktree_path: string;
  base_sha: string;
  result_sha: string | null;
  runtime_identity_json: string | null;
  containment_state: string;
  work_item_control_state: string;
  current_plan_revision: number | null;
  node_active: number | null;
  node_control_state: string | null;
}

function parseProof(value: string | null): ContainmentProof | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ContainmentProof;
  } catch {
    return null;
  }
}

function isCurrentAndActive(row: RecoverableRunRow): boolean {
  return (
    row.work_item_control_state === "active" &&
    row.current_plan_revision === row.plan_revision &&
    row.node_active === 1 &&
    row.node_control_state === "active"
  );
}

export class RecoveryCoordinator {
  private readonly database: DatabaseSync;
  private readonly containment: ContainmentPort;
  private readonly candidates: CandidateInspectionPort;
  private readonly maxAttempts: number;

  constructor(
    database: DatabaseSync,
    containment: ContainmentPort,
    candidates: CandidateInspectionPort,
    maxAttempts: number,
  ) {
    this.database = database;
    this.containment = containment;
    this.candidates = candidates;
    this.maxAttempts = maxAttempts;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be positive");
  }

  async scan(instance: Pick<InstanceLease, "ownerId" | "fence">, now: number): Promise<RecoveryDecision[]> {
    assertCurrentInstanceLease(this.database, instance, now);
    const rows = this.database
      .prepare(
        "SELECT r.id, r.work_item_id, r.plan_revision, r.node_id, r.attempt, r.worktree_path, r.base_sha, " +
          "r.result_sha, r.runtime_identity_json, r.containment_state, w.control_state AS work_item_control_state, " +
          "w.current_plan_revision, n.active AS node_active, n.control_state AS node_control_state " +
          "FROM collaboration_runs r JOIN collaboration_work_items w ON w.id = r.work_item_id " +
          "LEFT JOIN collaboration_work_nodes n ON n.work_item_id = r.work_item_id " +
          "AND n.plan_revision = r.plan_revision AND n.node_id = r.node_id " +
          "WHERE r.status = 'running' OR " +
          "(r.recovery_state = 'candidate_produced' AND n.runtime_state = 'validating') " +
          "ORDER BY r.started_at, r.id",
      )
      .all() as unknown as RecoverableRunRow[];
    const decisions: RecoveryDecision[] = [];
    for (const row of rows) decisions.push(await this.recoverOne(instance, row, now));
    return decisions;
  }

  private async recoverOne(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    row: RecoverableRunRow,
    now: number,
  ): Promise<RecoveryDecision> {
    if (!isCurrentAndActive(row)) {
      return this.persist(instance, row, now, "unsafe_to_retry", "none", "work_item_or_plan_inactive");
    }
    const proof = parseProof(row.runtime_identity_json);
    const verified = await verifyContainmentProof(this.containment, proof);
    if (!verified.verified || !proof) {
      return this.persist(
        instance,
        row,
        now,
        "needs_configuration",
        "none",
        "reason" in verified ? verified.reason : "containment_proof_missing",
      );
    }
    if (verified.fingerprint !== runtimeIdentityFingerprint(proof.identity)) {
      return this.persist(instance, row, now, "needs_configuration", "none", "containment_identity_mismatch");
    }
    const containment = await this.containment.inspect(proof.identity);
    if (containment.state === "unknown" || containment.fingerprint !== verified.fingerprint) {
      return this.persist(
        instance,
        row,
        now,
        "needs_configuration",
        "none",
        containment.state === "unknown" ? containment.reason : "containment_inspection_mismatch",
      );
    }
    if (containment.state === "active") {
      return this.persist(instance, row, now, "resumable", "reattach", "verified_containment_active");
    }
    const candidate = await this.candidates.inspect({
      runId: row.id,
      worktreePath: row.worktree_path,
      baseSha: row.base_sha,
      recordedResultSha: row.result_sha,
    });
    if (candidate.complete && candidate.resultSha) {
      return this.persist(
        instance,
        row,
        now,
        "candidate_produced",
        "deterministic_validation",
        "candidate_requires_deterministic_validation",
        candidate.resultSha,
      );
    }
    if (row.attempt < this.maxAttempts) {
      return this.persist(instance, row, now, "interrupted", "retry", candidate.reason ?? "containment_empty_no_candidate");
    }
    return this.persist(instance, row, now, "unsafe_to_retry", "none", "attempt_limit_exhausted");
  }

  private persist(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    row: RecoverableRunRow,
    now: number,
    classification: RecoveryClassification,
    nextAction: RecoveryDecision["nextAction"],
    reason: string,
    resultSha?: string,
  ): RecoveryDecision {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, now);
      const runStatus =
        classification === "candidate_produced"
          ? "succeeded"
          : classification === "interrupted" || classification === "unsafe_to_retry"
            ? "failed"
            : classification === "needs_configuration"
              ? "needs_configuration"
              : null;
      this.database
        .prepare(
          "UPDATE collaboration_runs SET recovery_state = ?, result_sha = COALESCE(?, result_sha), " +
            "status = COALESCE(?, status), finished_at = CASE WHEN ? IS NULL THEN finished_at ELSE ? END, " +
            "error = ? WHERE id = ? AND status = 'running'",
        )
        .run(classification, resultSha ?? null, runStatus, runStatus, now, reason, row.id);
      const runtimeState =
        classification === "candidate_produced"
          ? "validating"
          : classification === "interrupted"
            ? "interrupted"
            : classification === "needs_configuration"
              ? "needs_configuration"
              : classification === "unsafe_to_retry"
                ? "failed"
                : "running";
      this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET runtime_state = ?, execution_status = CASE " +
            "WHEN ? = 'candidate_produced' THEN 'running' " +
            "WHEN ? = 'interrupted' THEN 'not_started' " +
            "WHEN ? = 'needs_configuration' THEN 'needs_configuration' ELSE execution_status END, " +
            "lease_owner = NULL, lease_expires_at = NULL " +
            "WHERE work_item_id = ? AND plan_revision = ? AND node_id = ? " +
            "AND active = 1 AND control_state = 'active'",
        )
        .run(runtimeState, classification, classification, classification, row.work_item_id, row.plan_revision, row.node_id);
      this.database.exec("COMMIT");
      return { runId: row.id, classification, nextAction, reason };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
