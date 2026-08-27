import { createHash } from "node:crypto";
import { statfsSync } from "node:fs";

import { CollaborationDegradationController } from "../degradation.ts";
import type { InstanceLease } from "../leases.ts";
import type { PrivateOwnerAlertPort } from "./private-alert.ts";

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
  private readonly degradation: CollaborationDegradationController;
  private readonly alerts: PrivateOwnerAlertPort;
  private readonly capacityPort: DiskCapacityPort;
  private readonly policy: DiskMonitorPolicy;

  constructor(
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
    this.degradation = degradation;
    this.alerts = alerts;
    this.capacityPort = capacityPort;
    this.policy = policy;
  }

  async check(instance: Pick<InstanceLease, "ownerId" | "fence">, now: number): Promise<DiskMonitorResult> {
    const readiness = this.degradation.readiness();
    if (readiness.reason === "restore_review_required") throw new Error("restore_review_required");
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
        await this.alerts.alert({ code: "disk_probe_failed", digest: digest([errorClass]), occurredAt: now });
      }
      return { availableBytes: 0n, totalBytes: 0n, lowDisk: true, reason: "probe_failed" };
    }

    const belowBytes = capacity.availableBytes < this.policy.minimumAvailableBytes;
    const lowDisk = belowBytes || belowRatio(capacity, this.policy.minimumAvailableRatio);
    this.degradation.setLowDisk(instance, lowDisk, now);

    if (lowDisk && !wasLow) {
      await this.alerts.alert({
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

    return { ...capacity, lowDisk, reason: lowDisk ? "capacity_below_threshold" : null };
  }
}
