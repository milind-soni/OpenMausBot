import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openCollaborationLedger } from "./db.ts";
import { CollaborationDegradationController } from "./degradation.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function database(): DatabaseSync {
  const root = mkdtempSync(join(tmpdir(), "collaboration-degradation-"));
  scratch.push(root);
  const ledger = openCollaborationLedger(root);
  const path = ledger.filePath;
  ledger.close();
  return new DatabaseSync(path);
}

describe("fail-closed degradation", () => {
  it("gates new work on low disk without mutating existing evidence", () => {
    const db = database();
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1_000, 1_000)!;
    const controller = new CollaborationDegradationController(db);
    controller.setLowDisk(lease, true, 1_001);
    expect(() => controller.authorizeNewWork(lease, { action: "run.dispatch", now: 1_002 })).toThrow("low disk");
    expect(controller.readiness()).toEqual({ mode: "ready", reason: null, lowDisk: true });
    db.close();
  });

  it("does not authorize an Agent dispatch when the audit append fails", () => {
    const db = database();
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1_000, 1_000)!;
    db.exec(`
      CREATE TRIGGER test_reject_audit BEFORE INSERT ON collaboration_audit_events
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;
    `);
    const controller = new CollaborationDegradationController(db);
    expect(() => controller.authorizeNewWork(lease, { action: "run.dispatch", now: 1_001 })).toThrow(
      "audit unavailable",
    );
    expect(controller.readiness()).toMatchObject({ mode: "degraded", reason: "audit_unwritable" });
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_audit_events").get()).toEqual({ count: 0 });
    db.close();
  });
});
