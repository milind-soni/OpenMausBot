import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openCollaborationLedger } from "./db.ts";
import { InstanceLeaseCoordinator, NodeLeaseCoordinator, StaleFenceError } from "./leases.ts";
import { ProviderCircuitBreaker } from "./provider-circuit.ts";
import { FencedScheduler } from "./scheduler.ts";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function database(): DatabaseSync {
  const root = mkdtempSync(join(tmpdir(), "collaboration-scheduler-"));
  scratch.push(root);
  const ledger = openCollaborationLedger(root);
  const path = ledger.filePath;
  ledger.close();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    "INSERT INTO collaboration_work_nodes " +
      "(work_item_id, plan_revision, node_id, node_type, status, assigned_agent_id, objective, " +
      "input_evidence_json, instructions, read_scope_json, write_scope_json, deny_scope_json, commands_json, " +
      "expected_artifacts_json, completion_definition, risk, budget_json, created_at) " +
      "VALUES ('WI-1', 1, 'modify', 'modify', 'ready', 'developer', 'change', '[]', 'do it', '[]', '[]', " +
      "'[]', '[]', '[]', 'done', 'low', '{}', 1)",
  ).run();
  return db;
}

describe("fenced scheduler", () => {
  it("prevents an old instance from finalizing a node after takeover", () => {
    const db = database();
    const first = new InstanceLeaseCoordinator(db, "scheduler-a");
    const leaseA = first.acquire(1_000, 50)!;
    const scheduler = new FencedScheduler(
      db,
      new ProviderCircuitBreaker(db, { failureThreshold: 2, openDurationMs: 100, maxOpenDurationMs: 1_000 }),
    );
    const claim = scheduler.claimReadyNode(leaseA, {
      workItemId: "WI-1",
      planRevision: 1,
      nodeId: "modify",
      providerId: "provider-a",
      nodeLeaseTtlMs: 100,
      now: 1_000,
    })!;
    new InstanceLeaseCoordinator(db, "scheduler-b").acquire(1_051, 1_000);
    expect(() => scheduler.finalizeNode(leaseA, claim, "succeeded", 1_052)).toThrow(StaleFenceError);
    expect(db.prepare("SELECT runtime_state FROM collaboration_work_nodes").get()).toEqual({ runtime_state: "leased" });
    db.close();
  });

  it("does not consume a half-open probe when no node can be claimed", () => {
    for (const unavailable of ["missing", "competing_claim"] as const) {
      const db = database();
      const lease = new InstanceLeaseCoordinator(db, `scheduler-${unavailable}`).acquire(1_000, 1_000)!;
      const circuit = new ProviderCircuitBreaker(db, {
        failureThreshold: 1,
        openDurationMs: 100,
        maxOpenDurationMs: 1_000,
      });
      circuit.allowDispatch(lease, "provider-a", 1_000);
      circuit.recordFailure(lease, "provider-a", "provider", 1_001);
      if (unavailable === "missing") {
        db.prepare("DELETE FROM collaboration_work_nodes").run();
      } else {
        new NodeLeaseCoordinator(db).claim(lease, {
          workItemId: "WI-1",
          planRevision: 1,
          nodeId: "modify",
          now: 1_100,
          ttlMs: 500,
        });
      }
      const scheduler = new FencedScheduler(db, circuit);
      expect(
        scheduler.claimReadyNode(lease, {
          workItemId: "WI-1",
          planRevision: 1,
          nodeId: "modify",
          providerId: "provider-a",
          nodeLeaseTtlMs: 500,
          now: 1_101,
        }),
      ).toBeNull();
      expect(
        db.prepare("SELECT state, probe_owner, probe_fence FROM collaboration_provider_circuits").get(),
      ).toEqual({ state: "open", probe_owner: null, probe_fence: null });
      db.close();
    }
  });
});
