import type { DatabaseSync } from "node:sqlite";

import { assertCurrentInstanceLease, type InstanceLease, StaleFenceError } from "./leases.ts";

export type ProviderFailureClass =
  | "provider"
  | "transport"
  | "system"
  | "user_cancelled"
  | "policy_denied"
  | "invalid_diff"
  | "test_failed";

export interface ProviderCircuitOptions {
  failureThreshold: number;
  openDurationMs: number;
  maxOpenDurationMs: number;
  probeDurationMs?: number;
}

interface CircuitRow {
  state: "closed" | "open" | "half_open";
  consecutive_failures: number;
  retry_at: number | null;
  probe_owner: string | null;
  probe_fence: number | null;
  probe_expires_at: number | null;
  version: number;
}

const COUNTED_FAILURES = new Set<ProviderFailureClass>(["provider", "transport", "system"]);

export class ProviderCircuitBreaker {
  private readonly database: DatabaseSync;
  private readonly options: ProviderCircuitOptions;

  constructor(database: DatabaseSync, options: ProviderCircuitOptions) {
    this.database = database;
    this.options = options;
    if (!Number.isInteger(options.failureThreshold) || options.failureThreshold < 1) {
      throw new Error("Provider circuit failureThreshold must be positive");
    }
    if (options.openDurationMs < 1 || options.maxOpenDurationMs < options.openDurationMs) {
      throw new Error("Invalid Provider circuit duration");
    }
    if ((options.probeDurationMs ?? options.openDurationMs) < 1) throw new Error("Invalid Provider probe duration");
  }

  allowDispatch(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    providerId: string,
    now: number,
  ): { allowed: boolean; probe: boolean; retryAt: number | null; probeExpiresAt: number | null } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, now);
      let row = this.read(providerId);
      if (!row) {
        this.database
          .prepare(
            "INSERT INTO collaboration_provider_circuits " +
              "(provider_id, state, consecutive_failures, updated_at, version) VALUES (?, 'closed', 0, ?, 1)",
          )
          .run(providerId, now);
        row = this.read(providerId)!;
      }
      if (row.state === "closed") {
        this.database.exec("COMMIT");
        return { allowed: true, probe: false, retryAt: null, probeExpiresAt: null };
      }
      if (row.state === "open" && row.retry_at !== null && row.retry_at <= now) {
        const changed = this.database
          .prepare(
            "UPDATE collaboration_provider_circuits SET state = 'half_open', probe_owner = ?, probe_fence = ?, " +
              "probe_expires_at = ?, " +
              "updated_at = ?, version = version + 1 WHERE provider_id = ? AND state = 'open' AND version = ?",
          )
          .run(
            instance.ownerId,
            instance.fence,
            now + (this.options.probeDurationMs ?? this.options.openDurationMs),
            now,
            providerId,
            row.version,
          );
        if (changed.changes !== 1) throw new StaleFenceError("Provider probe claim is stale");
        this.database.exec("COMMIT");
        return {
          allowed: true,
          probe: true,
          retryAt: row.retry_at,
          probeExpiresAt: now + (this.options.probeDurationMs ?? this.options.openDurationMs),
        };
      }
      if (
        row.state === "half_open" &&
        (row.probe_expires_at === null ||
          row.probe_expires_at <= now ||
          row.probe_owner !== instance.ownerId ||
          row.probe_fence !== instance.fence)
      ) {
        const probeExpiresAt = now + (this.options.probeDurationMs ?? this.options.openDurationMs);
        const changed = this.database
          .prepare(
            "UPDATE collaboration_provider_circuits SET probe_owner = ?, probe_fence = ?, probe_expires_at = ?, " +
              "updated_at = ?, version = version + 1 WHERE provider_id = ? AND state = 'half_open' AND version = ?",
          )
          .run(instance.ownerId, instance.fence, probeExpiresAt, now, providerId, row.version);
        if (changed.changes !== 1) throw new StaleFenceError("Provider probe reclaim is stale");
        this.database.exec("COMMIT");
        return { allowed: true, probe: true, retryAt: row.retry_at, probeExpiresAt };
      }
      this.database.exec("COMMIT");
      return { allowed: false, probe: false, retryAt: row.retry_at, probeExpiresAt: row.probe_expires_at };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordSuccess(instance: Pick<InstanceLease, "ownerId" | "fence">, providerId: string, now: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, now);
      const row = this.read(providerId);
      if (!row) throw new Error(`Provider circuit is not initialized: ${providerId}`);
      if (
        row.state === "half_open" &&
        (row.probe_owner !== instance.ownerId || row.probe_fence !== instance.fence ||
          row.probe_expires_at === null || row.probe_expires_at <= now)
      ) {
        throw new StaleFenceError("Provider circuit probe is stale");
      }
      this.database
        .prepare(
          "UPDATE collaboration_provider_circuits SET state = 'closed', consecutive_failures = 0, " +
            "opened_at = NULL, retry_at = NULL, probe_owner = NULL, probe_fence = NULL, " +
            "probe_expires_at = NULL, " +
            "last_failure_class = NULL, updated_at = ?, version = version + 1 WHERE provider_id = ? AND version = ?",
        )
        .run(now, providerId, row.version);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordFailure(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    providerId: string,
    failureClass: ProviderFailureClass,
    now: number,
  ): void {
    if (!COUNTED_FAILURES.has(failureClass)) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, now);
      const row = this.read(providerId);
      if (!row) throw new Error(`Provider circuit is not initialized: ${providerId}`);
      if (
        row.state === "half_open" &&
        (row.probe_owner !== instance.ownerId || row.probe_fence !== instance.fence ||
          row.probe_expires_at === null || row.probe_expires_at <= now)
      ) {
        throw new StaleFenceError("Provider circuit probe is stale");
      }
      const failures = row.consecutive_failures + 1;
      const shouldOpen = row.state === "half_open" || failures >= this.options.failureThreshold;
      const multiplier = Math.max(1, failures - this.options.failureThreshold + 1);
      const duration = Math.min(this.options.maxOpenDurationMs, this.options.openDurationMs * 2 ** (multiplier - 1));
      this.database
        .prepare(
          "UPDATE collaboration_provider_circuits SET state = ?, consecutive_failures = ?, " +
            "opened_at = ?, retry_at = ?, probe_owner = NULL, probe_fence = NULL, probe_expires_at = NULL, " +
            "last_failure_class = ?, " +
            "updated_at = ?, version = version + 1 WHERE provider_id = ? AND version = ?",
        )
        .run(
          shouldOpen ? "open" : "closed",
          failures,
          shouldOpen ? now : null,
          shouldOpen ? now + duration : null,
          failureClass,
          now,
          providerId,
          row.version,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseProbe(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    providerId: string,
    now: number,
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, now);
      const changed = this.database
        .prepare(
          "UPDATE collaboration_provider_circuits SET state = 'open', retry_at = ?, probe_owner = NULL, " +
            "probe_fence = NULL, probe_expires_at = NULL, updated_at = ?, version = version + 1 " +
            "WHERE provider_id = ? AND state = 'half_open' AND probe_owner = ? AND probe_fence = ?",
        )
        .run(now, now, providerId, instance.ownerId, instance.fence);
      if (changed.changes !== 1) throw new StaleFenceError("Provider probe release is stale");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private read(providerId: string): CircuitRow | null {
    return (
      (this.database
        .prepare(
          "SELECT state, consecutive_failures, retry_at, probe_owner, probe_fence, probe_expires_at, version " +
            "FROM collaboration_provider_circuits WHERE provider_id = ?",
        )
        .get(providerId) as CircuitRow | undefined) ?? null
    );
  }
}
