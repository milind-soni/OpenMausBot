import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { assertCurrentInstanceLease, type InstanceLease } from "./leases.ts";

export type DegradationReason = "ledger_unwritable" | "audit_unwritable" | "recovery_failed" | "lease_failed";

export interface RuntimeReadiness {
  mode: "ready" | "degraded";
  reason: string | null;
  lowDisk: boolean;
}

export class CollaborationDegradationController {
  private volatileFailure: DegradationReason | null = null;
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  readiness(): RuntimeReadiness {
    const row = this.database
      .prepare("SELECT mode, reason, low_disk FROM collaboration_runtime_state WHERE singleton = 1")
      .get() as { mode: "ready" | "degraded"; reason: string | null; low_disk: number };
    return {
      mode: this.volatileFailure ? "degraded" : row.mode,
      reason: this.volatileFailure ?? row.reason,
      lowDisk: row.low_disk === 1,
    };
  }

  setLowDisk(instance: Pick<InstanceLease, "ownerId" | "fence">, lowDisk: boolean, now: number): void {
    assertCurrentInstanceLease(this.database, instance, now);
    this.database
      .prepare(
        "UPDATE collaboration_runtime_state SET low_disk = ?, updated_at = ?, version = version + 1 WHERE singleton = 1",
      )
      .run(lowDisk ? 1 : 0, now);
  }

  degrade(instance: Pick<InstanceLease, "ownerId" | "fence">, reason: DegradationReason, now: number): void {
    assertCurrentInstanceLease(this.database, instance, now);
    this.database
      .prepare(
        "UPDATE collaboration_runtime_state SET mode = 'degraded', reason = ?, updated_at = ?, version = version + 1 " +
          "WHERE singleton = 1",
      )
      .run(reason, now);
  }

  authorizeNewWork(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    input: { action: string; workItemId?: string; now: number },
  ): void {
    assertCurrentInstanceLease(this.database, instance, input.now);
    const before = this.readiness();
    if (before.mode === "degraded") throw new Error(`Collaboration service degraded: ${before.reason}`);
    if (before.lowDisk) throw new Error("Collaboration service has low disk; new work is gated");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, input.now);
      const readiness = this.readiness();
      if (readiness.mode === "degraded") throw new Error(`Collaboration service degraded: ${readiness.reason}`);
      if (readiness.lowDisk) throw new Error("Collaboration service has low disk; new work is gated");
      this.database
        .prepare(
          "INSERT INTO collaboration_audit_events " +
            "(id, action, outcome, resource_json, created_at, work_item_id, request_id, policy_rule) " +
            "VALUES (?, ?, 'allow', ?, ?, ?, ?, 'fenced-dispatch-ready')",
        )
        .run(
          randomUUID(),
          input.action,
          JSON.stringify({ instanceOwner: instance.ownerId, instanceFence: instance.fence }),
          input.now,
          input.workItemId ?? null,
          randomUUID(),
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      this.volatileFailure = "audit_unwritable";
      throw error;
    }
  }
}
