import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openCollaborationLedger } from "./db.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";
import { ProviderCircuitBreaker } from "./provider-circuit.ts";

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function database(): DatabaseSync {
  const root = mkdtempSync(join(tmpdir(), "collaboration-circuit-"));
  scratch.push(root);
  const ledger = openCollaborationLedger(root);
  const path = ledger.filePath;
  ledger.close();
  return new DatabaseSync(path);
}

describe("persistent Provider circuit", () => {
  it("opens on counted failures, survives reconstruction, and permits one fenced half-open probe", () => {
    const db = database();
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1_000, 5_000)!;
    const options = { failureThreshold: 2, openDurationMs: 100, maxOpenDurationMs: 1_000 };
    let circuit = new ProviderCircuitBreaker(db, options);
    expect(circuit.allowDispatch(lease, "provider-a", 1_000)).toEqual({
      allowed: true,
      probe: false,
      retryAt: null,
      probeExpiresAt: null,
    });
    circuit.recordFailure(lease, "provider-a", "test_failed", 1_001);
    circuit.recordFailure(lease, "provider-a", "provider", 1_002);
    expect(circuit.allowDispatch(lease, "provider-a", 1_003).allowed).toBe(true);
    circuit.recordFailure(lease, "provider-a", "transport", 1_004);
    expect(circuit.allowDispatch(lease, "provider-a", 1_005)).toEqual({
      allowed: false,
      probe: false,
      retryAt: 1_104,
      probeExpiresAt: null,
    });

    circuit = new ProviderCircuitBreaker(db, options);
    expect(circuit.allowDispatch(lease, "provider-a", 1_104)).toEqual({
      allowed: true,
      probe: true,
      retryAt: 1_104,
      probeExpiresAt: 1_204,
    });
    expect(circuit.allowDispatch(lease, "provider-a", 1_104).allowed).toBe(false);
    circuit.recordSuccess(lease, "provider-a", 1_105);
    expect(circuit.allowDispatch(lease, "provider-a", 1_106)).toEqual({
      allowed: true,
      probe: false,
      retryAt: null,
      probeExpiresAt: null,
    });
    db.close();
  });

  it("reclaims a half-open probe after its scheduler lease is replaced", () => {
    const db = database();
    const first = new InstanceLeaseCoordinator(db, "scheduler-a");
    const leaseA = first.acquire(1_000, 150)!;
    const circuit = new ProviderCircuitBreaker(db, {
      failureThreshold: 1,
      openDurationMs: 100,
      maxOpenDurationMs: 1_000,
      probeDurationMs: 500,
    });
    circuit.allowDispatch(leaseA, "provider-a", 1_000);
    circuit.recordFailure(leaseA, "provider-a", "provider", 1_001);
    expect(circuit.allowDispatch(leaseA, "provider-a", 1_101)).toMatchObject({ allowed: true, probe: true });
    const leaseB = new InstanceLeaseCoordinator(db, "scheduler-b").acquire(1_151, 1_000)!;
    expect(circuit.allowDispatch(leaseB, "provider-a", 1_152)).toMatchObject({
      allowed: true,
      probe: true,
      probeExpiresAt: 1_652,
    });
    expect(() => circuit.recordSuccess(leaseA, "provider-a", 1_153)).toThrow();
    circuit.recordSuccess(leaseB, "provider-a", 1_153);
    db.close();
  });

  it("reclaims an expired half-open probe even when the scheduler process survived", () => {
    const db = database();
    const lease = new InstanceLeaseCoordinator(db, "scheduler").acquire(1_000, 5_000)!;
    const circuit = new ProviderCircuitBreaker(db, {
      failureThreshold: 1,
      openDurationMs: 100,
      maxOpenDurationMs: 1_000,
      probeDurationMs: 50,
    });
    circuit.allowDispatch(lease, "provider-a", 1_000);
    circuit.recordFailure(lease, "provider-a", "provider", 1_001);
    expect(circuit.allowDispatch(lease, "provider-a", 1_101)).toMatchObject({
      allowed: true,
      probe: true,
      probeExpiresAt: 1_151,
    });
    expect(circuit.allowDispatch(lease, "provider-a", 1_151)).toMatchObject({
      allowed: true,
      probe: true,
      probeExpiresAt: 1_201,
    });
    circuit.recordSuccess(lease, "provider-a", 1_152);
    db.close();
  });
});
