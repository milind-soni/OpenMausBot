import type { DatabaseSync } from "node:sqlite";

export interface InstanceLease {
  ownerId: string;
  fence: number;
  expiresAt: number;
  version: number;
}

export interface NodeLease {
  workItemId: string;
  planRevision: number;
  nodeId: string;
  ownerId: string;
  fence: number;
  expiresAt: number;
}

export class StaleFenceError extends Error {
  constructor(message = "Scheduler lease is stale") {
    super(message);
    this.name = "StaleFenceError";
  }
}

interface InstanceLeaseRow {
  owner_id: string;
  fencing_token: number;
  expires_at: number;
  version: number;
}

function positiveDuration(value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error("Lease TTL must be a positive integer");
}

export function currentInstanceLease(database: DatabaseSync): InstanceLease | null {
  const row = database
    .prepare("SELECT owner_id, fencing_token, expires_at, version FROM collaboration_instance_lease WHERE singleton = 1")
    .get() as InstanceLeaseRow | undefined;
  return row
    ? { ownerId: row.owner_id, fence: row.fencing_token, expiresAt: row.expires_at, version: row.version }
    : null;
}

export function assertCurrentInstanceLease(
  database: DatabaseSync,
  lease: Pick<InstanceLease, "ownerId" | "fence">,
  now: number,
): void {
  const row = database
    .prepare(
      "SELECT 1 FROM collaboration_instance_lease " +
        "WHERE singleton = 1 AND owner_id = ? AND fencing_token = ? AND expires_at > ?",
    )
    .get(lease.ownerId, lease.fence, now);
  if (!row) throw new StaleFenceError();
}

export class InstanceLeaseCoordinator {
  private readonly database: DatabaseSync;
  readonly ownerId: string;

  constructor(database: DatabaseSync, ownerId: string) {
    this.database = database;
    this.ownerId = ownerId;
    if (!ownerId.trim()) throw new Error("Instance lease ownerId is required");
  }

  acquire(now: number, ttlMs: number): InstanceLease | null {
    positiveDuration(ttlMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = currentInstanceLease(this.database);
      if (current && current.expiresAt > now && current.ownerId !== this.ownerId) {
        this.database.exec("COMMIT");
        return null;
      }
      const expiresAt = now + ttlMs;
      if (!current) {
        this.database
          .prepare(
            "INSERT INTO collaboration_instance_lease " +
              "(singleton, owner_id, fencing_token, acquired_at, heartbeat_at, expires_at, version) " +
              "VALUES (1, ?, 1, ?, ?, ?, 1)",
          )
          .run(this.ownerId, now, now, expiresAt);
      } else if (current.ownerId === this.ownerId && current.expiresAt > now) {
        this.database
          .prepare(
            "UPDATE collaboration_instance_lease SET heartbeat_at = ?, expires_at = ?, version = version + 1 " +
              "WHERE singleton = 1 AND owner_id = ? AND fencing_token = ? AND version = ?",
          )
          .run(now, expiresAt, this.ownerId, current.fence, current.version);
      } else {
        this.database
          .prepare(
            "UPDATE collaboration_instance_lease SET owner_id = ?, fencing_token = fencing_token + 1, " +
              "acquired_at = ?, heartbeat_at = ?, expires_at = ?, version = version + 1 " +
              "WHERE singleton = 1 AND fencing_token = ? AND version = ? AND expires_at <= ?",
          )
          .run(this.ownerId, now, now, expiresAt, current.fence, current.version, now);
      }
      const acquired = currentInstanceLease(this.database);
      if (!acquired || acquired.ownerId !== this.ownerId || acquired.expiresAt !== expiresAt) {
        throw new StaleFenceError("Instance lease acquisition lost its compare-and-swap");
      }
      this.database.exec("COMMIT");
      return acquired;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  renew(lease: Pick<InstanceLease, "ownerId" | "fence">, now: number, ttlMs: number): InstanceLease {
    positiveDuration(ttlMs);
    const result = this.database
      .prepare(
        "UPDATE collaboration_instance_lease SET heartbeat_at = ?, expires_at = ?, version = version + 1 " +
          "WHERE singleton = 1 AND owner_id = ? AND fencing_token = ? AND expires_at > ?",
      )
      .run(now, now + ttlMs, lease.ownerId, lease.fence, now);
    if (result.changes !== 1) throw new StaleFenceError();
    return currentInstanceLease(this.database)!;
  }

  release(lease: Pick<InstanceLease, "ownerId" | "fence">, now: number): void {
    const result = this.database
      .prepare(
        "UPDATE collaboration_instance_lease SET heartbeat_at = ?, expires_at = ?, version = version + 1 " +
          "WHERE singleton = 1 AND owner_id = ? AND fencing_token = ? AND expires_at > ?",
      )
      .run(now - 1, now, lease.ownerId, lease.fence, now);
    if (result.changes !== 1) throw new StaleFenceError();
  }
}

export class NodeLeaseCoordinator {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  claim(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    input: { workItemId: string; planRevision: number; nodeId: string; now: number; ttlMs: number },
  ): NodeLease | null {
    positiveDuration(input.ttlMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, input.now);
      const result = this.database
        .prepare(
          "UPDATE collaboration_work_nodes SET lease_owner = ?, lease_expires_at = ?, " +
            "lease_fence = COALESCE(lease_fence, 0) + 1, runtime_state = 'leased' " +
            "WHERE work_item_id = ? AND plan_revision = ? AND node_id = ? AND active = 1 " +
            "AND control_state = 'active' AND status = 'ready' " +
            "AND (lease_expires_at IS NULL OR lease_expires_at <= ?)",
        )
        .run(
          instance.ownerId,
          input.now + input.ttlMs,
          input.workItemId,
          input.planRevision,
          input.nodeId,
          input.now,
        );
      if (result.changes !== 1) {
        this.database.exec("COMMIT");
        return null;
      }
      const row = this.database
        .prepare(
          "SELECT lease_fence, lease_expires_at FROM collaboration_work_nodes " +
            "WHERE work_item_id = ? AND plan_revision = ? AND node_id = ?",
        )
        .get(input.workItemId, input.planRevision, input.nodeId) as {
        lease_fence: number;
        lease_expires_at: number;
      };
      this.database.exec("COMMIT");
      return {
        workItemId: input.workItemId,
        planRevision: input.planRevision,
        nodeId: input.nodeId,
        ownerId: instance.ownerId,
        fence: row.lease_fence,
        expiresAt: row.lease_expires_at,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeat(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    lease: NodeLease,
    now: number,
    ttlMs: number,
  ): NodeLease {
    positiveDuration(ttlMs);
    assertCurrentInstanceLease(this.database, instance, now);
    const result = this.database
      .prepare(
        "UPDATE collaboration_work_nodes SET lease_expires_at = ? " +
          "WHERE work_item_id = ? AND plan_revision = ? AND node_id = ? " +
          "AND lease_owner = ? AND lease_fence = ? AND lease_expires_at > ?",
      )
      .run(
        now + ttlMs,
        lease.workItemId,
        lease.planRevision,
        lease.nodeId,
        lease.ownerId,
        lease.fence,
        now,
      );
    if (result.changes !== 1) throw new StaleFenceError("Node lease is stale");
    return { ...lease, expiresAt: now + ttlMs };
  }
}
