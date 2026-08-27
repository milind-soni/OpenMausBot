import type { DatabaseSync } from "node:sqlite";

import {
  type ContainmentPort,
  type ContainmentBinding,
  type ContainmentProof,
  runtimeIdentityFingerprint,
  verifyContainmentProof,
} from "./containment.ts";
import { assertCurrentInstanceLease, type InstanceLease, StaleFenceError } from "./leases.ts";

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
  status: string;
  interrupt_requested_at: number | null;
  run_version: number;
  instance_owner: string | null;
  instance_fence: number | null;
  node_lease_fence: number | null;
  runtime_identity_json: string | null;
  containment_state: string;
  containment_fingerprint: string | null;
  containment_binding_json: string | null;
  work_item_control_state: string;
  current_plan_revision: number | null;
  node_active: number | null;
  node_control_state: string | null;
  node_lease_fence_current: number | null;
  node_version: number | null;
}

function parseProof(value: string | null): ContainmentProof | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ContainmentProof;
  } catch {
    return null;
  }
}

function parseBinding(value: string | null): ContainmentBinding | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ContainmentBinding;
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
          "r.result_sha, r.status, r.interrupt_requested_at, r.version AS run_version, r.instance_owner, " +
          "r.instance_fence, r.node_lease_fence, r.runtime_identity_json, r.containment_state, " +
          "r.containment_fingerprint, r.containment_binding_json, " +
          "w.control_state AS work_item_control_state, w.current_plan_revision, n.active AS node_active, " +
          "n.control_state AS node_control_state, n.lease_fence AS node_lease_fence_current, " +
          "n.version AS node_version " +
          "FROM collaboration_runs r JOIN collaboration_work_items w ON w.id = r.work_item_id " +
          "LEFT JOIN collaboration_work_nodes n ON n.work_item_id = r.work_item_id " +
          "AND n.plan_revision = r.plan_revision AND n.node_id = r.node_id " +
          "WHERE r.status = 'running' " +
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
    const binding = parseBinding(row.containment_binding_json);
    if (
      !binding ||
      binding.runId !== row.id ||
      binding.commandId !== undefined ||
      binding.canonicalWorktreePath !== row.worktree_path ||
      binding.instanceOwner !== row.instance_owner ||
      binding.instanceFence !== row.instance_fence
    ) {
      return this.persist(instance, row, now, "needs_configuration", "none", "containment_binding_missing");
    }
    const verified = await verifyContainmentProof(this.containment, proof, binding);
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
    if (row.containment_fingerprint !== verified.fingerprint) {
      return this.persist(instance, row, now, "needs_configuration", "none", "containment_fingerprint_changed");
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
      const current = this.database
        .prepare(
          "SELECT r.status, r.interrupt_requested_at, r.version AS run_version, r.instance_owner, " +
            "r.instance_fence, r.node_lease_fence, w.control_state AS work_item_control_state, " +
            "w.current_plan_revision, n.active AS node_active, n.control_state AS node_control_state, " +
            "n.lease_fence AS node_lease_fence_current, n.version AS node_version " +
            "FROM collaboration_runs r JOIN collaboration_work_items w ON w.id = r.work_item_id " +
            "JOIN collaboration_work_nodes n ON n.work_item_id = r.work_item_id " +
            "AND n.plan_revision = r.plan_revision AND n.node_id = r.node_id WHERE r.id = ?",
        )
        .get(row.id) as
        | Pick<
            RecoverableRunRow,
            | "status"
            | "interrupt_requested_at"
            | "run_version"
            | "instance_owner"
            | "instance_fence"
            | "node_lease_fence"
            | "work_item_control_state"
            | "current_plan_revision"
            | "node_active"
            | "node_control_state"
            | "node_lease_fence_current"
            | "node_version"
          >
        | undefined;
      if (
        !current ||
        current.status !== "running" ||
        current.interrupt_requested_at !== null ||
        current.work_item_control_state !== "active" ||
        current.current_plan_revision !== row.plan_revision ||
        current.node_active !== 1 ||
        current.node_control_state !== "active" ||
        current.run_version !== row.run_version ||
        current.node_version !== row.node_version ||
        current.instance_owner !== row.instance_owner ||
        current.instance_fence !== row.instance_fence ||
        current.node_lease_fence !== row.node_lease_fence ||
        current.node_lease_fence_current !== row.node_lease_fence_current
      ) {
        this.database.exec("COMMIT");
        return {
          runId: row.id,
          classification: "unsafe_to_retry",
          nextAction: "none",
          reason: "state_changed_during_recovery",
        };
      }
      const runStatus =
        classification === "candidate_produced"
          ? "succeeded"
          : classification === "interrupted" || classification === "unsafe_to_retry"
            ? "failed"
            : classification === "needs_configuration"
              ? "needs_configuration"
              : null;
      const runUpdated = this.database
        .prepare(
          "UPDATE collaboration_runs SET recovery_state = ?, result_sha = COALESCE(?, result_sha), " +
            "status = COALESCE(?, status), finished_at = CASE WHEN ? IS NULL THEN finished_at ELSE ? END, " +
            "error = ?, version = version + 1 WHERE id = ? AND status = 'running' " +
            "AND interrupt_requested_at IS NULL AND version = ?",
        )
        .run(classification, resultSha ?? null, runStatus, runStatus, now, reason, row.id, row.run_version);
      if (runUpdated.changes !== 1) throw new StaleFenceError("Recovery run CAS is stale");
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
      const nodeUpdated = this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET runtime_state = ?, execution_status = CASE " +
            "WHEN ? = 'candidate_produced' THEN 'running' " +
            "WHEN ? = 'interrupted' THEN 'not_started' " +
            "WHEN ? = 'needs_configuration' THEN 'needs_configuration' ELSE execution_status END, " +
            "lease_owner = CASE WHEN ? = 'resumable' THEN lease_owner ELSE NULL END, " +
            "lease_expires_at = CASE WHEN ? = 'resumable' THEN lease_expires_at ELSE NULL END, " +
            "version = version + 1 " +
            "WHERE work_item_id = ? AND plan_revision = ? AND node_id = ? " +
            "AND active = 1 AND control_state = 'active' AND version = ? " +
            "AND lease_fence IS ?",
        )
        .run(
          runtimeState,
          classification,
          classification,
          classification,
          classification,
          classification,
          row.work_item_id,
          row.plan_revision,
          row.node_id,
          row.node_version,
          row.node_lease_fence_current,
        );
      if (nodeUpdated.changes !== 1) throw new StaleFenceError("Recovery node CAS is stale");
      this.database.exec("COMMIT");
      return { runId: row.id, classification, nextAction, reason };
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (error instanceof StaleFenceError) {
        return {
          runId: row.id,
          classification: "unsafe_to_retry",
          nextAction: "none",
          reason: "state_changed_during_recovery",
        };
      }
      throw error;
    }
  }
}
