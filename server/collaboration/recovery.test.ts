import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  containmentBindingHash,
  runtimeIdentityFingerprint,
  type ContainmentBinding,
  type ContainmentPort,
  type ContainmentProof,
} from "./containment.ts";
import { openCollaborationLedger } from "./db.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { type CandidateInspectionPort, RecoveryCoordinator } from "./recovery.ts";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const runtimeBinding: ContainmentBinding = {
  runId: "RUN-1",
  canonicalWorktreePath: "/managed/worktree",
  instanceOwner: "old-scheduler",
  instanceFence: 1,
  nonce: "recovery-nonce-00000000000000000001",
};

const proof: ContainmentProof = {
  identity: {
    backend: "verified_service",
    opaqueId: "opaque-runtime-identity-0001",
    hostGeneration: "host-generation-1",
    verifierVersion: "verifier-v1",
  },
  receipt: containmentBindingHash(runtimeBinding),
};

function database(controlState = "active", active = 1, runtimeProof: ContainmentProof = proof): DatabaseSync {
  const root = mkdtempSync(join(tmpdir(), "collaboration-recovery-"));
  scratch.push(root);
  const ledger = openCollaborationLedger(root);
  const path = ledger.filePath;
  ledger.close();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    "INSERT INTO collaboration_work_items " +
      "(id, conversation_id, title, status, version, created_by, created_at, updated_at, " +
      "definition_status, current_plan_revision, control_state) " +
      "VALUES ('WI-1', 'conversation', 'test', 'collecting', 1, 'principal', 1, 1, 'ready_for_execution', 1, ?)",
  ).run(controlState);
  db.prepare(
    "INSERT INTO collaboration_work_nodes " +
      "(work_item_id, plan_revision, node_id, node_type, status, assigned_agent_id, objective, " +
      "input_evidence_json, instructions, read_scope_json, write_scope_json, deny_scope_json, commands_json, " +
      "expected_artifacts_json, completion_definition, risk, budget_json, active, created_at, execution_status, " +
      "control_state, runtime_state, lease_fence) VALUES ('WI-1', 1, 'modify', 'modify', 'ready', 'developer', 'change', " +
      "'[]', 'do it', '[]', '[]', '[]', '[]', '[]', 'done', 'low', '{}', ?, 1, 'running', 'active', 'running', 1)",
  ).run(active);
  db.prepare(
    "INSERT INTO collaboration_runs " +
      "(id, work_item_id, plan_revision, node_id, attempt, agent_id, thread_id, turn_id, status, repository_path, " +
      "worktree_path, branch, base_sha, started_at, runtime_identity_json, containment_state, instance_owner, " +
      "instance_fence, node_lease_fence, containment_binding_json, containment_fingerprint) " +
      "VALUES ('RUN-1', 'WI-1', 1, 'modify', 1, 'developer', 'thread', 'turn', 'running', '/repo', " +
      "'/managed/worktree', 'branch', ?, 1, ?, 'verified', 'old-scheduler', 1, 1, ?, ?)",
  ).run(
    "a".repeat(40),
    JSON.stringify(runtimeProof),
    JSON.stringify(runtimeBinding),
    runtimeIdentityFingerprint(runtimeProof.identity),
  );
  return db;
}

class FakeContainment implements ContainmentPort {
  inspections = 0;
  constructor(private readonly state: "active" | "empty" = "empty") {}
  async verifyProof(input: ContainmentProof, expectedBinding: ContainmentBinding) {
    const bindingHash = containmentBindingHash(expectedBinding);
    return input.receipt === bindingHash
      ? { verified: true as const, fingerprint: runtimeIdentityFingerprint(input.identity), bindingHash }
      : { verified: false as const, reason: "unverified" };
  }
  async inspect(identity: ContainmentProof["identity"]) {
    this.inspections += 1;
    return { state: this.state, fingerprint: runtimeIdentityFingerprint(identity) };
  }
  async terminateAndWaitEmpty(identity: ContainmentProof["identity"]) {
    return { state: "empty" as const, fingerprint: runtimeIdentityFingerprint(identity) };
  }
}

class FakeCandidates implements CandidateInspectionPort {
  calls = 0;
  constructor(private readonly complete: boolean) {}
  async inspect() {
    this.calls += 1;
    return { complete: this.complete, resultSha: this.complete ? "b".repeat(40) : null };
  }
}

class DeferredContainment extends FakeContainment {
  readonly started: Promise<void>;
  private signalStarted: (() => void) | undefined;
  private resolveInspection: ((value: { state: "empty"; fingerprint: string }) => void) | undefined;

  constructor() {
    super("empty");
    let signal: (() => void) | undefined;
    this.started = new Promise<void>((resolve) => (signal = resolve));
    this.signalStarted = signal;
  }

  override inspect(_identity: ContainmentProof["identity"]) {
    this.inspections += 1;
    this.signalStarted?.();
    return new Promise<{ state: "empty"; fingerprint: string }>((resolve) => {
      this.resolveInspection = resolve;
    });
  }

  finish(): void {
    this.resolveInspection!({ state: "empty", fingerprint: runtimeIdentityFingerprint(proof.identity) });
  }
}

describe("run recovery", () => {
  it("routes a completed candidate directly to deterministic validation", async () => {
    const db = database();
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1_000, 1_000)!;
    const candidates = new FakeCandidates(true);
    const decisions = await new RecoveryCoordinator(db, new FakeContainment("empty"), candidates, 3).scan(lease, 1_001);
    expect(decisions).toEqual([
      {
        runId: "RUN-1",
        classification: "candidate_produced",
        nextAction: "deterministic_validation",
        reason: "candidate_requires_deterministic_validation",
      },
    ]);
    expect(candidates.calls).toBe(1);
    expect(db.prepare("SELECT status, recovery_state FROM collaboration_runs WHERE id = 'RUN-1'").get()).toEqual({
      status: "succeeded",
      recovery_state: "candidate_produced",
    });
    expect(db.prepare("SELECT runtime_state FROM collaboration_work_nodes").get()).toEqual({ runtime_state: "validating" });
    db.close();
  });

  it("never auto-readies paused, cancelled, accepted, or obsolete work", async () => {
    for (const [controlState, active] of [
      ["paused", 1],
      ["cancelled", 1],
      ["accepted", 1],
      ["active", 0],
    ] as const) {
      const db = database(controlState, active);
      const lease = new InstanceLeaseCoordinator(db, `scheduler-${controlState}-${active}`).acquire(1_000, 1_000)!;
      const candidates = new FakeCandidates(true);
      const [decision] = await new RecoveryCoordinator(db, new FakeContainment(), candidates, 3).scan(lease, 1_001);
      expect(decision).toMatchObject({ classification: "unsafe_to_retry", nextAction: "none" });
      expect(candidates.calls).toBe(0);
      db.close();
    }
  });

  it("fails closed for process-group identity without inspecting PID liveness", async () => {
    const processGroupProof: ContainmentProof = {
      identity: { ...proof.identity, backend: "process_group", opaqueId: "1234567890123456" },
      receipt: proof.receipt,
    };
    const db = database("active", 1, processGroupProof);
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1_000, 1_000)!;
    const containment = new FakeContainment("active");
    const [decision] = await new RecoveryCoordinator(db, containment, new FakeCandidates(false), 3).scan(lease, 1_001);
    expect(decision).toMatchObject({
      classification: "needs_configuration",
      reason: "unsupported_process_identity",
      nextAction: "none",
    });
    expect(containment.inspections).toBe(0);
    db.close();
  });

  it("does not revive work paused, cancelled, or superseded while containment inspection is awaiting", async () => {
    for (const mutation of ["pause", "cancel", "supersede"] as const) {
      const db = database();
      const lease = new InstanceLeaseCoordinator(db, `scheduler-${mutation}`).acquire(1_000, 1_000)!;
      const containment = new DeferredContainment();
      const pending = new RecoveryCoordinator(db, containment, new FakeCandidates(true), 3).scan(lease, 1_001);
      await containment.started;
      if (mutation === "supersede") {
        db.prepare("UPDATE collaboration_work_items SET current_plan_revision = 2 WHERE id = 'WI-1'").run();
        db.prepare("UPDATE collaboration_work_nodes SET active = 0, version = version + 1 WHERE work_item_id = 'WI-1'").run();
      } else {
        db.prepare("UPDATE collaboration_work_items SET control_state = ? WHERE id = 'WI-1'").run(
          mutation === "pause" ? "paused" : "cancelled",
        );
        db.prepare(
          "UPDATE collaboration_work_nodes SET control_state = ?, version = version + 1 WHERE work_item_id = 'WI-1'",
        ).run(mutation === "pause" ? "paused" : "cancelled");
        db.prepare(
          "UPDATE collaboration_runs SET interrupt_requested_at = 1_002, version = version + 1 WHERE id = 'RUN-1'",
        ).run();
      }
      containment.finish();
      expect(await pending).toEqual([
        {
          runId: "RUN-1",
          classification: "unsafe_to_retry",
          nextAction: "none",
          reason: "state_changed_during_recovery",
        },
      ]);
      expect(db.prepare("SELECT status, result_sha FROM collaboration_runs WHERE id = 'RUN-1'").get()).toEqual({
        status: "running",
        result_sha: null,
      });
      db.close();
    }
  });

  it("does not persist a recovery result after the instance fence changes during inspection", async () => {
    const db = database();
    const lease = new InstanceLeaseCoordinator(db, "scheduler-a").acquire(1_000, 50)!;
    const containment = new DeferredContainment();
    const pending = new RecoveryCoordinator(db, containment, new FakeCandidates(true), 3).scan(lease, 1_001);
    await containment.started;
    new InstanceLeaseCoordinator(db, "scheduler-b").acquire(1_051, 1_000);
    containment.finish();
    expect(await pending).toEqual([
      {
        runId: "RUN-1",
        classification: "unsafe_to_retry",
        nextAction: "none",
        reason: "state_changed_during_recovery",
      },
    ]);
    expect(db.prepare("SELECT status, result_sha FROM collaboration_runs WHERE id = 'RUN-1'").get()).toEqual({
      status: "running",
      result_sha: null,
    });
    db.close();
  });

  it("does not inspect containment or candidates for a restored review ledger", async () => {
    const db = database();
    const lease = new InstanceLeaseCoordinator(db, "review-scheduler").acquire(1_000, 1_000)!;
    db.prepare(
      "UPDATE collaboration_restore_guard SET state = 'review_required', source_backup_hash = ?, restored_at = 1, " +
        "version = version + 1 WHERE singleton = 1",
    ).run("b".repeat(64));
    const containment = new FakeContainment();
    const candidates = new FakeCandidates(true);
    await expect(new RecoveryCoordinator(db, containment, candidates, 3).scan(lease, 1_001)).rejects.toThrow(
      "restore_review_required",
    );
    expect(containment.inspections).toBe(0);
    expect(candidates.calls).toBe(0);
    db.close();
  });
});
