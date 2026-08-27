import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  runtimeIdentityFingerprint,
  type ContainmentPort,
  type ContainmentProof,
} from "./containment.ts";
import { openCollaborationLedger } from "./db.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { type CandidateInspectionPort, RecoveryCoordinator } from "./recovery.ts";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const proof: ContainmentProof = {
  identity: {
    backend: "verified_service",
    opaqueId: "opaque-runtime-identity-0001",
    hostGeneration: "host-generation-1",
    verifierVersion: "verifier-v1",
  },
  receipt: "verified-receipt",
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
      "control_state, runtime_state) VALUES ('WI-1', 1, 'modify', 'modify', 'ready', 'developer', 'change', " +
      "'[]', 'do it', '[]', '[]', '[]', '[]', '[]', 'done', 'low', '{}', ?, 1, 'running', 'active', 'running')",
  ).run(active);
  db.prepare(
    "INSERT INTO collaboration_runs " +
      "(id, work_item_id, plan_revision, node_id, attempt, agent_id, thread_id, turn_id, status, repository_path, " +
      "worktree_path, branch, base_sha, started_at, runtime_identity_json, containment_state) " +
      "VALUES ('RUN-1', 'WI-1', 1, 'modify', 1, 'developer', 'thread', 'turn', 'running', '/repo', " +
      "'/managed/worktree', 'branch', ?, 1, ?, 'verified')",
  ).run("a".repeat(40), JSON.stringify(runtimeProof));
  return db;
}

class FakeContainment implements ContainmentPort {
  inspections = 0;
  constructor(private readonly state: "active" | "empty" = "empty") {}
  async verifyProof(input: ContainmentProof) {
    return input.receipt === proof.receipt
      ? { verified: true as const, fingerprint: runtimeIdentityFingerprint(input.identity) }
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
});
