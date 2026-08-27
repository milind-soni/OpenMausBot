import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openCollaborationLedger } from "./db.ts";
import { InstanceLeaseCoordinator, NodeLeaseCoordinator, StaleFenceError } from "./leases.ts";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function database(): DatabaseSync {
  const root = mkdtempSync(join(tmpdir(), "collaboration-leases-"));
  scratch.push(root);
  const ledger = openCollaborationLedger(root);
  const path = ledger.filePath;
  ledger.close();
  return new DatabaseSync(path);
}

function seedReadyNode(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    "INSERT INTO collaboration_work_nodes " +
      "(work_item_id, plan_revision, node_id, node_type, status, assigned_agent_id, objective, " +
      "input_evidence_json, instructions, read_scope_json, write_scope_json, deny_scope_json, " +
      "commands_json, expected_artifacts_json, completion_definition, risk, budget_json, created_at) " +
      "VALUES ('WI-1', 1, 'modify', 'modify', 'ready', 'developer', 'change', '[]', 'do it', '[]', " +
      "'[]', '[]', '[]', '[]', 'done', 'low', '{}', 1)",
  ).run();
}

describe("fenced leases", () => {
  it("allows one active owner and monotonically fences an expired takeover", () => {
    const db = database();
    const first = new InstanceLeaseCoordinator(db, "scheduler-a");
    const second = new InstanceLeaseCoordinator(db, "scheduler-b");
    const leaseA = first.acquire(1_000, 100)!;
    expect(leaseA.fence).toBe(1);
    expect(first.acquire(1_050, 100)).toMatchObject({ ownerId: "scheduler-a", fence: 1 });
    expect(second.acquire(1_060, 100)).toBeNull();
    const leaseB = second.acquire(1_151, 100)!;
    expect(leaseB).toMatchObject({ ownerId: "scheduler-b", fence: 2 });
    expect(() => first.renew(leaseA, 1_152, 100)).toThrow(StaleFenceError);
    db.close();
  });

  it("claims a node only under the current instance fence and rejects stale heartbeats", () => {
    const db = database();
    seedReadyNode(db);
    const first = new InstanceLeaseCoordinator(db, "scheduler-a");
    const second = new InstanceLeaseCoordinator(db, "scheduler-b");
    const leaseA = first.acquire(1_000, 100)!;
    const nodes = new NodeLeaseCoordinator(db);
    const nodeA = nodes.claim(leaseA, {
      workItemId: "WI-1",
      planRevision: 1,
      nodeId: "modify",
      now: 1_000,
      ttlMs: 50,
    })!;
    expect(nodeA.fence).toBe(1);
    const leaseB = second.acquire(1_101, 100)!;
    expect(() => nodes.heartbeat(leaseA, nodeA, 1_102, 50)).toThrow(StaleFenceError);
    const nodeB = nodes.claim(leaseB, {
      workItemId: "WI-1",
      planRevision: 1,
      nodeId: "modify",
      now: 1_102,
      ttlMs: 50,
    })!;
    expect(nodeB.fence).toBe(2);
    db.close();
  });
});
