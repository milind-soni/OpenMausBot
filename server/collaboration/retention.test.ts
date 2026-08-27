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
import { InstanceLeaseCoordinator, StaleFenceError } from "./leases.ts";
import { type WorktreeCleanupPort, WorktreeRetentionManager } from "./retention.ts";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const runtimeBinding: ContainmentBinding = {
  runId: "RUN-1",
  canonicalWorktreePath: "/managed/worktree",
  instanceOwner: "old-scheduler",
  instanceFence: 1,
  nonce: "retention-nonce-00000000000000000001",
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

function database(): DatabaseSync {
  const root = mkdtempSync(join(tmpdir(), "collaboration-retention-"));
  scratch.push(root);
  const ledger = openCollaborationLedger(root);
  const path = ledger.filePath;
  ledger.close();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    "INSERT INTO collaboration_runs " +
      "(id, work_item_id, plan_revision, node_id, attempt, agent_id, thread_id, turn_id, status, repository_path, " +
      "worktree_path, branch, base_sha, started_at, runtime_identity_json, containment_state, " +
      "containment_binding_json, containment_fingerprint) " +
      "VALUES ('RUN-1', 'WI-1', 1, 'modify', 1, 'developer', 'thread', 'turn', 'succeeded', '/repo', " +
      "'/managed/worktree', 'branch', ?, 1, ?, 'verified', ?, ?)",
  ).run(
    "a".repeat(40),
    JSON.stringify(proof),
    JSON.stringify(runtimeBinding),
    runtimeIdentityFingerprint(proof.identity),
  );
  db.prepare(
    "INSERT INTO collaboration_audit_events (id, run_id, action, outcome, resource_json, created_at) " +
      "VALUES ('AUDIT-1', 'RUN-1', 'candidate.finalized', 'success', '{}', 1)",
  ).run();
  db.prepare(
    "INSERT INTO collaboration_candidates " +
      "(id, run_id, state, base_sha, result_sha, changed_paths_json, violations_json, quality_json, created_at) " +
      "VALUES ('CANDIDATE-1', 'RUN-1', 'not_verified', ?, ?, '[]', '[]', '{}', 1)",
  ).run("a".repeat(40), "b".repeat(40));
  return db;
}

class EmptyContainment implements ContainmentPort {
  async verifyProof(input: ContainmentProof, expectedBinding: ContainmentBinding) {
    return {
      verified: true as const,
      fingerprint: runtimeIdentityFingerprint(input.identity),
      bindingHash: containmentBindingHash(expectedBinding),
    };
  }
  async inspect(identity: ContainmentProof["identity"]) {
    return { state: "empty" as const, fingerprint: runtimeIdentityFingerprint(identity) };
  }
  async terminateAndWaitEmpty(identity: ContainmentProof["identity"]) {
    return { state: "empty" as const, fingerprint: runtimeIdentityFingerprint(identity) };
  }
}

class FakeCleanup implements WorktreeCleanupPort {
  removed: string[] = [];
  async isManagedPath(path: string) {
    return path.startsWith("/managed/");
  }
  async remove(input: { path: string }) {
    this.removed.push(input.path);
  }
}

describe("worktree retention", () => {
  it("preserves evidence until retention elapses and cleans only verified empty managed worktrees", async () => {
    const db = database();
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1_000, 100_000)!;
    const cleanup = new FakeCleanup();
    const retention = new WorktreeRetentionManager(db, new EmptyContainment(), cleanup, {
      successMs: 1_000,
      failureOrCancellationMs: 3_000,
    });
    expect(retention.schedule(lease, "RUN-1", "success", 1_000)).toBe(2_000);
    expect(await retention.cleanupExpired(lease, 1_999)).toEqual([]);
    expect(cleanup.removed).toEqual([]);
    expect(await retention.cleanupExpired(lease, 2_000)).toEqual([
      { runId: "RUN-1", cleaned: true, reason: "retention_elapsed" },
    ]);
    expect(cleanup.removed).toEqual(["/managed/worktree"]);
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_audit_events").get()).toEqual({ count: 1 });
    db.close();
  });

  it("rejects cleanup under an obsolete scheduler fence", async () => {
    const db = database();
    const first = new InstanceLeaseCoordinator(db, "scheduler-a");
    const leaseA = first.acquire(1_000, 50)!;
    const retention = new WorktreeRetentionManager(db, new EmptyContainment(), new FakeCleanup(), {
      successMs: 10,
      failureOrCancellationMs: 20,
    });
    retention.schedule(leaseA, "RUN-1", "success", 1_000);
    new InstanceLeaseCoordinator(db, "scheduler-b").acquire(1_051, 1_000);
    await expect(retention.cleanupExpired(leaseA, 1_052)).rejects.toThrow(StaleFenceError);
    expect(db.prepare("SELECT cleaned_at FROM collaboration_runs WHERE id = 'RUN-1'").get()).toEqual({
      cleaned_at: null,
    });
    db.close();
  });

  it("never removes an original worktree while a restored ledger is under review", async () => {
    const db = database();
    const lease = new InstanceLeaseCoordinator(db, "review-scheduler").acquire(1_000, 100_000)!;
    db.prepare("UPDATE collaboration_runs SET retention_until = 1 WHERE id = 'RUN-1'").run();
    db.prepare(
      "UPDATE collaboration_restore_guard SET state = 'review_required', source_backup_hash = ?, restored_at = 1, " +
        "version = version + 1 WHERE singleton = 1",
    ).run("a".repeat(64));
    const cleanup = new FakeCleanup();
    const retention = new WorktreeRetentionManager(db, new EmptyContainment(), cleanup, {
      successMs: 10,
      failureOrCancellationMs: 20,
    });
    expect(() => retention.schedule(lease, "RUN-1", "success", 1_001)).toThrow("restore_review_required");
    await expect(retention.cleanupExpired(lease, 1_001)).rejects.toThrow("restore_review_required");
    expect(cleanup.removed).toEqual([]);
    expect(db.prepare("SELECT cleaned_at FROM collaboration_runs WHERE id = 'RUN-1'").get()).toEqual({ cleaned_at: null });
    db.close();
  });
});
