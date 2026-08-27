import type { DatabaseSync } from "node:sqlite";

import { CollaborationDegradationController } from "./degradation.ts";
import {
  assertCurrentInstanceLease,
  type InstanceLease,
  type NodeLease,
  NodeLeaseCoordinator,
  StaleFenceError,
} from "./leases.ts";
import { ProviderCircuitBreaker } from "./provider-circuit.ts";
import { assertLedgerArmed } from "./restore-guard.ts";

export interface SchedulerClaim {
  nodeLease: NodeLease;
  providerId: string;
  halfOpenProbe: boolean;
}

/**
 * Durable dispatch gate. It intentionally does not run Provider code itself;
 * callers may cross that boundary only after this class has appended the
 * dispatch audit and acquired a fenced node lease.
 */
export class FencedScheduler {
  private readonly database: DatabaseSync;
  private readonly nodes: NodeLeaseCoordinator;
  private readonly degradation: CollaborationDegradationController;
  private readonly circuits: ProviderCircuitBreaker;

  constructor(
    database: DatabaseSync,
    circuits: ProviderCircuitBreaker,
    degradation = new CollaborationDegradationController(database),
  ) {
    this.database = database;
    this.nodes = new NodeLeaseCoordinator(database);
    this.degradation = degradation;
    this.circuits = circuits;
  }

  claimReadyNode(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    input: {
      workItemId: string;
      planRevision: number;
      nodeId: string;
      providerId: string;
      nodeLeaseTtlMs: number;
      now: number;
    },
  ): SchedulerClaim | null {
    assertLedgerArmed(this.database);
    this.degradation.authorizeNewWork(instance, {
      action: "scheduler.node_dispatch",
      workItemId: input.workItemId,
      now: input.now,
    });
    const nodeLease = this.nodes.claim(instance, {
      workItemId: input.workItemId,
      planRevision: input.planRevision,
      nodeId: input.nodeId,
      now: input.now,
      ttlMs: input.nodeLeaseTtlMs,
    });
    if (!nodeLease) return null;
    let provider: ReturnType<ProviderCircuitBreaker["allowDispatch"]>;
    try {
      provider = this.circuits.allowDispatch(instance, input.providerId, input.now);
    } catch (error) {
      this.nodes.release(instance, nodeLease, input.now);
      throw error;
    }
    if (!provider.allowed) {
      this.nodes.release(instance, nodeLease, input.now);
      return null;
    }
    return { nodeLease, providerId: input.providerId, halfOpenProbe: provider.probe };
  }

  finalizeNode(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    claim: SchedulerClaim,
    outcome: "succeeded" | "failed" | "needs_configuration" | "interrupted",
    now: number,
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, now);
      const updated = this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET runtime_state = ?, lease_owner = NULL, lease_expires_at = NULL, " +
            "version = version + 1 " +
            "WHERE work_item_id = ? AND plan_revision = ? AND node_id = ? " +
            "AND lease_owner = ? AND lease_fence = ? AND lease_expires_at > ?",
        )
        .run(
          outcome,
          claim.nodeLease.workItemId,
          claim.nodeLease.planRevision,
          claim.nodeLease.nodeId,
          claim.nodeLease.ownerId,
          claim.nodeLease.fence,
          now,
        );
      if (updated.changes !== 1) throw new StaleFenceError("Node finalization is stale");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
