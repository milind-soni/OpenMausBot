import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openCollaborationLedger } from "../db.ts";
import { CollaborationDegradationController } from "../degradation.ts";
import { InstanceLeaseCoordinator, StaleFenceError } from "../leases.ts";
import { markRestoredLedgerForReview } from "../restore-guard.ts";
import { CollaborationDiskMonitor, type DiskCapacity, type DiskCapacityPort } from "./disk-monitor.ts";
import type { PrivateOwnerAlertPort, SafeOperationalAlert } from "./private-alert.ts";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function database(): DatabaseSync {
  const root = mkdtempSync(join(tmpdir(), "collaboration-disk-monitor-"));
  scratch.push(root);
  const ledger = openCollaborationLedger(root);
  const path = ledger.filePath;
  ledger.close();
  return new DatabaseSync(path);
}

class FakeCapacity implements DiskCapacityPort {
  value: DiskCapacity | Error = { availableBytes: 500n, totalBytes: 1_000n };

  capacity(): DiskCapacity {
    if (this.value instanceof Error) throw this.value;
    return this.value;
  }
}

class FakePrivateAlerts implements PrivateOwnerAlertPort {
  readonly deliveries: SafeOperationalAlert[] = [];

  async alert(input: SafeOperationalAlert): Promise<void> {
    this.deliveries.push(input);
  }
}

function monitor(db: DatabaseSync, capacity: FakeCapacity, alerts: FakePrivateAlerts): CollaborationDiskMonitor {
  return new CollaborationDiskMonitor(new CollaborationDegradationController(db), alerts, capacity, {
    dataDirectory: "/private-ledger",
    minimumAvailableBytes: 200n,
    minimumAvailableRatio: 0.1,
  });
}

describe("collaboration disk monitor", () => {
  it("gates new work under a valid lease and warns only through the private alert port", async () => {
    const db = database();
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1_000, 1_000)!;
    const degradation = new CollaborationDegradationController(db);
    const capacity = new FakeCapacity();
    capacity.value = { availableBytes: 50n, totalBytes: 1_000n };
    const alerts = new FakePrivateAlerts();
    const disk = new CollaborationDiskMonitor(degradation, alerts, capacity, {
      dataDirectory: "/private-ledger",
      minimumAvailableBytes: 200n,
      minimumAvailableRatio: 0.1,
    });

    await expect(disk.check(lease, 1_001)).resolves.toMatchObject({ lowDisk: true, reason: "capacity_below_threshold" });
    expect(() => degradation.authorizeNewWork(lease, { action: "run.dispatch", now: 1_002 })).toThrow("low disk");
    expect(alerts.deliveries).toEqual([
      expect.objectContaining({ code: "disk_low", occurredAt: 1_001, digest: expect.stringMatching(/^sha256:/) }),
    ]);
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_runs").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM collaboration_test_evidence").get()).toEqual({ count: 0 });
    db.close();
  });

  it("clears only the low-disk gate after capacity recovers and does not repeat alerts", async () => {
    const db = database();
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1_000, 1_000)!;
    const capacity = new FakeCapacity();
    const alerts = new FakePrivateAlerts();
    const disk = monitor(db, capacity, alerts);

    capacity.value = { availableBytes: 50n, totalBytes: 1_000n };
    await disk.check(lease, 1_001);
    await disk.check(lease, 1_002);
    capacity.value = { availableBytes: 500n, totalBytes: 1_000n };
    await expect(disk.check(lease, 1_003)).resolves.toMatchObject({ lowDisk: false, reason: null });

    expect(alerts.deliveries).toHaveLength(1);
    expect(new CollaborationDegradationController(db).readiness().lowDisk).toBe(false);
    db.close();
  });

  it("fails closed on an unreadable filesystem and rejects a stale instance fence", async () => {
    const db = database();
    const first = new InstanceLeaseCoordinator(db, "scheduler-a");
    const lease = first.acquire(1_000, 50)!;
    const capacity = new FakeCapacity();
    capacity.value = new Error("sensitive path must not be delivered");
    const alerts = new FakePrivateAlerts();
    const disk = monitor(db, capacity, alerts);

    await expect(disk.check(lease, 1_001)).resolves.toMatchObject({ lowDisk: true, reason: "probe_failed" });
    expect(JSON.stringify(alerts.deliveries)).not.toContain("sensitive path");
    new InstanceLeaseCoordinator(db, "scheduler-b").acquire(1_051, 1_000);
    await expect(disk.check(lease, 1_052)).rejects.toBeInstanceOf(StaleFenceError);
    db.close();
  });

  it("does not mutate or alert from a restored review ledger", async () => {
    const db = database();
    const lease = new InstanceLeaseCoordinator(db, "review-runtime").acquire(1_000, 1_000)!;
    markRestoredLedgerForReview(db, Buffer.from("encrypted-backup-artifact"), 1_001);
    const capacity = new FakeCapacity();
    capacity.value = { availableBytes: 1n, totalBytes: 1_000n };
    const alerts = new FakePrivateAlerts();
    const disk = monitor(db, capacity, alerts);

    await expect(disk.check(lease, 1_002)).rejects.toThrow("restore_review_required");
    expect(db.prepare("SELECT low_disk FROM collaboration_runtime_state WHERE singleton = 1").get()).toEqual({
      low_disk: 0,
    });
    expect(alerts.deliveries).toEqual([]);
    db.close();
  });
});
