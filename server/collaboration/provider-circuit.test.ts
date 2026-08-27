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
    expect(circuit.allowDispatch(lease, "provider-a", 1_000)).toEqual({ allowed: true, probe: false, retryAt: null });
    circuit.recordFailure(lease, "provider-a", "test_failed", 1_001);
    circuit.recordFailure(lease, "provider-a", "provider", 1_002);
    expect(circuit.allowDispatch(lease, "provider-a", 1_003).allowed).toBe(true);
    circuit.recordFailure(lease, "provider-a", "transport", 1_004);
    expect(circuit.allowDispatch(lease, "provider-a", 1_005)).toEqual({
      allowed: false,
      probe: false,
      retryAt: 1_104,
    });

    circuit = new ProviderCircuitBreaker(db, options);
    expect(circuit.allowDispatch(lease, "provider-a", 1_104)).toEqual({
      allowed: true,
      probe: true,
      retryAt: 1_104,
    });
    expect(circuit.allowDispatch(lease, "provider-a", 1_104).allowed).toBe(false);
    circuit.recordSuccess(lease, "provider-a", 1_105);
    expect(circuit.allowDispatch(lease, "provider-a", 1_106)).toEqual({ allowed: true, probe: false, retryAt: null });
    db.close();
  });
});
