import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openCollaborationLedger } from "./db.ts";
import { InstanceLeaseCoordinator, StaleFenceError } from "./leases.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { enqueueInboundCard, type OutboxDeliveryPort } from "./outbox.ts";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function database(): DatabaseSync {
  const root = mkdtempSync(join(tmpdir(), "collaboration-outbox-"));
  scratch.push(root);
  const ledger = openCollaborationLedger(root);
  const path = ledger.filePath;
  ledger.close();
  return new DatabaseSync(path);
}

function enqueue(db: DatabaseSync, version: number, now: number): string {
  return enqueueInboundCard(db, {
    sourceEventId: `event-${version}`,
    aggregateType: "plan",
    aggregateId: "WI-1",
    aggregateVersion: version,
    supersessionKey: "plan:WI-1",
    card: {
      type: "plan_status_card",
      headline: "计划已发布",
      workItemId: "WI-1",
      planRevision: version,
      status: "ready_for_execution",
      sequence: ["analyze", "modify", "validate", "report"],
    },
    now,
  }).id;
}

describe("fenced outbox dispatcher", () => {
  it("suppresses obsolete aggregate versions and delivers only the newest", async () => {
    const db = database();
    const oldId = enqueue(db, 1, 1_000);
    const newId = enqueue(db, 2, 1_001);
    const delivered: number[] = [];
    const transport: OutboxDeliveryPort = {
      async deliver(message) {
        delivered.push(message.aggregateVersion);
        return { outcome: "sent" };
      },
    };
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1_001, 1_000)!;
    const dispatcher = new OutboxDispatcher(db, transport, {
      maxAttempts: 3,
      claimTtlMs: 100,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
    });
    expect(await dispatcher.dispatchOne(lease, 1_002)).toEqual({ id: newId, state: "sent", attempt: 1 });
    expect(delivered).toEqual([2]);
    expect(db.prepare("SELECT delivery_state FROM collaboration_outbox WHERE id = ?").get(oldId)).toEqual({
      delivery_state: "superseded",
    });
    db.close();
  });

  it("persists bounded retry/backoff and dead-letters after the maximum", async () => {
    const db = database();
    const id = enqueue(db, 1, 1_000);
    const transport: OutboxDeliveryPort = {
      async deliver() {
        return { outcome: "retryable", error: "rate_limited" };
      },
    };
    const leases = new InstanceLeaseCoordinator(db, "scheduler");
    let lease = leases.acquire(1_000, 1_000)!;
    const dispatcher = new OutboxDispatcher(db, transport, {
      maxAttempts: 2,
      claimTtlMs: 100,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
      jitter: () => 3,
    });
    expect(await dispatcher.dispatchOne(lease, 1_000)).toEqual({ id, state: "retry_scheduled", attempt: 1 });
    expect(db.prepare("SELECT next_attempt_at FROM collaboration_outbox WHERE id = ?").get(id)).toEqual({
      next_attempt_at: 1_013,
    });
    lease = leases.renew(lease, 1_013, 1_000);
    expect(await dispatcher.dispatchOne(lease, 1_013)).toEqual({ id, state: "dead_letter", attempt: 2 });
    expect(db.prepare("SELECT delivery_state, attempt FROM collaboration_outbox WHERE id = ?").get(id)).toEqual({
      delivery_state: "dead_letter",
      attempt: 2,
    });
    db.close();
  });

  it("does not let an obsolete scheduler mark a claimed message sent", async () => {
    const db = database();
    enqueue(db, 1, 1_000);
    let resolveDelivery: ((value: { outcome: "sent" }) => void) | undefined;
    const transport: OutboxDeliveryPort = {
      deliver: () => new Promise((resolve) => (resolveDelivery = resolve)),
    };
    const first = new InstanceLeaseCoordinator(db, "scheduler-a");
    const leaseA = first.acquire(1_000, 50)!;
    const dispatcher = new OutboxDispatcher(db, transport, {
      maxAttempts: 2,
      claimTtlMs: 100,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
    });
    const pending = dispatcher.dispatchOne(leaseA, 1_000);
    await Promise.resolve();
    new InstanceLeaseCoordinator(db, "scheduler-b").acquire(1_051, 100);
    resolveDelivery!({ outcome: "sent" });
    await expect(pending).rejects.toThrow(StaleFenceError);
    expect(db.prepare("SELECT sent_at FROM collaboration_outbox").get()).toEqual({ sent_at: null });
    db.close();
  });

  it("serializes superseding versions behind an in-flight older delivery", async () => {
    const db = database();
    const oldId = enqueue(db, 1, 1_000);
    let resolveOld: ((value: { outcome: "sent" }) => void) | undefined;
    const versions: number[] = [];
    const transport: OutboxDeliveryPort = {
      deliver(message) {
        versions.push(message.aggregateVersion);
        if (message.aggregateVersion === 1) return new Promise((resolve) => (resolveOld = resolve));
        return Promise.resolve({ outcome: "sent" });
      },
    };
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1_000, 1_000)!;
    const dispatcher = new OutboxDispatcher(db, transport, {
      maxAttempts: 3,
      claimTtlMs: 100,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
    });
    const inFlight = dispatcher.dispatchOne(lease, 1_000);
    await Promise.resolve();
    const newId = enqueue(db, 2, 1_001);
    expect(await dispatcher.dispatchOne(lease, 1_001)).toBeNull();
    resolveOld!({ outcome: "sent" });
    expect(await inFlight).toEqual({ id: oldId, state: "superseded", attempt: 1 });
    expect(await dispatcher.dispatchOne(lease, 1_002)).toEqual({ id: newId, state: "sent", attempt: 1 });
    expect(versions).toEqual([1, 2]);
    db.close();
  });
});
