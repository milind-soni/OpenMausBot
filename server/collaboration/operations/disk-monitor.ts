import { createHash } from "node:crypto";
import { statfsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { CollaborationDegradationController } from "../degradation.ts";
import { assertCurrentInstanceLease, type InstanceLease } from "../leases.ts";
import type { PrivateOwnerAlertPort, SafeOperationalAlert } from "./private-alert.ts";

export interface DiskCapacity {
  availableBytes: bigint;
  totalBytes: bigint;
}

export interface DiskCapacityPort {
  capacity(path: string): DiskCapacity;
}

export class NodeDiskCapacityPort implements DiskCapacityPort {
  capacity(path: string): DiskCapacity {
    const stats = statfsSync(path, { bigint: true });
    return {
      availableBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
    };
  }
}

export interface DiskMonitorPolicy {
  dataDirectory: string;
  minimumAvailableBytes: bigint;
  minimumAvailableRatio: number;
}

export interface DiskMonitorResult extends DiskCapacity {
  lowDisk: boolean;
  reason: "capacity_below_threshold" | "probe_failed" | null;
}

function digest(parts: readonly string[]): string {
  return `sha256:${createHash("sha256").update(parts.join(":"), "utf8").digest("hex")}`;
}

function belowRatio(capacity: DiskCapacity, minimumRatio: number): boolean {
  const scale = 1_000_000n;
  const threshold = BigInt(Math.ceil(minimumRatio * Number(scale)));
  return capacity.availableBytes * scale < capacity.totalBytes * threshold;
}

export class CollaborationDiskMonitor {
  private readonly database: DatabaseSync;
  private readonly degradation: CollaborationDegradationController;
  private readonly alerts: PrivateOwnerAlertPort;
  private readonly capacityPort: DiskCapacityPort;
  private readonly policy: DiskMonitorPolicy;

  constructor(
    database: DatabaseSync,
    degradation: CollaborationDegradationController,
    alerts: PrivateOwnerAlertPort,
    capacityPort: DiskCapacityPort,
    policy: DiskMonitorPolicy,
  ) {
    if (!policy.dataDirectory) throw new Error("Disk monitor dataDirectory is required");
    if (policy.minimumAvailableBytes < 0n) throw new Error("minimumAvailableBytes cannot be negative");
    if (
      !Number.isFinite(policy.minimumAvailableRatio) ||
      policy.minimumAvailableRatio < 0 ||
      policy.minimumAvailableRatio > 1
    ) {
      throw new Error("minimumAvailableRatio must be between zero and one");
    }
    this.database = database;
    this.degradation = degradation;
    this.alerts = alerts;
    this.capacityPort = capacityPort;
    this.policy = policy;
  }

  async check(instance: Pick<InstanceLease, "ownerId" | "fence">, now: number): Promise<DiskMonitorResult> {
    this.degradation.assertArmed();
    const readiness = this.degradation.readiness();
    const wasLow = readiness.lowDisk;
    let capacity: DiskCapacity;
    try {
      capacity = this.capacityPort.capacity(this.policy.dataDirectory);
      if (capacity.availableBytes < 0n || capacity.totalBytes <= 0n || capacity.availableBytes > capacity.totalBytes) {
        throw new Error("invalid_disk_capacity");
      }
    } catch (error) {
      this.degradation.setLowDisk(instance, true, now);
      if (!wasLow) {
        const errorClass = error instanceof Error ? error.name : "UnknownError";
        this.queueAlert({ code: "disk_probe_failed", digest: digest([errorClass]), occurredAt: now });
      }
      await this.deliverPending(instance, now);
      return { availableBytes: 0n, totalBytes: 0n, lowDisk: true, reason: "probe_failed" };
    }

    const belowBytes = capacity.availableBytes < this.policy.minimumAvailableBytes;
    const lowDisk = belowBytes || belowRatio(capacity, this.policy.minimumAvailableRatio);
    this.degradation.setLowDisk(instance, lowDisk, now);

    if (lowDisk && !wasLow) {
      this.queueAlert({
        code: "disk_low",
        digest: digest([
          capacity.availableBytes.toString(),
          capacity.totalBytes.toString(),
          this.policy.minimumAvailableBytes.toString(),
          this.policy.minimumAvailableRatio.toString(),
        ]),
        occurredAt: now,
      });
    }
    await this.deliverPending(instance, now);

    return { ...capacity, lowDisk, reason: lowDisk ? "capacity_below_threshold" : null };
  }

  async run(instance: Pick<InstanceLease, "ownerId" | "fence">, now: number): Promise<void> {
    await this.check(instance, now);
  }

  private queueAlert(alert: SafeOperationalAlert): void {
    this.database
      .prepare(
        "INSERT INTO collaboration_private_alert_state " +
          "(code, digest, occurred_at, delivery_state, attempt) VALUES (?, ?, ?, 'pending', 0) " +
          "ON CONFLICT(code) DO UPDATE SET digest = excluded.digest, occurred_at = excluded.occurred_at, " +
          "delivery_state = 'pending', attempt = 0, last_attempt_at = NULL, delivered_at = NULL",
      )
      .run(alert.code, alert.digest, alert.occurredAt);
  }

  private async deliverPending(instance: Pick<InstanceLease, "ownerId" | "fence">, now: number): Promise<void> {
    const pending = this.database
      .prepare(
        "SELECT code, digest, occurred_at FROM collaboration_private_alert_state " +
          "WHERE delivery_state = 'pending' ORDER BY occurred_at, code",
      )
      .all() as unknown as Array<{ code: string; digest: string; occurred_at: number }>;
    for (const row of pending) {
      assertCurrentInstanceLease(this.database, instance, now);
      this.database
        .prepare(
          "UPDATE collaboration_private_alert_state SET attempt = attempt + 1, last_attempt_at = ? " +
            "WHERE code = ? AND digest = ? AND occurred_at = ? AND delivery_state = 'pending'",
        )
        .run(now, row.code, row.digest, row.occurred_at);
      await this.alerts.alert({ code: row.code, digest: row.digest, occurredAt: row.occurred_at });
      assertCurrentInstanceLease(this.database, instance, now);
      this.database
        .prepare(
          "UPDATE collaboration_private_alert_state SET delivery_state = 'sent', delivered_at = ? " +
            "WHERE code = ? AND digest = ? AND occurred_at = ? AND delivery_state = 'pending'",
        )
        .run(now, row.code, row.digest, row.occurred_at);
    }
  }
}
