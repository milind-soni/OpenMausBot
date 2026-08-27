import type { DatabaseSync } from "node:sqlite";

import { assertCurrentInstanceLease, type InstanceLease, StaleFenceError } from "./leases.ts";
import type { CollaborationOutboxEntry, OutboxDeliveryPort } from "./outbox.ts";

interface DispatchRow {
  id: string;
  source: "dingtalk";
  dedupe_key: string;
  aggregate_type: CollaborationOutboxEntry["aggregateType"];
  aggregate_id: string;
  aggregate_version: number;
  kind: CollaborationOutboxEntry["kind"];
  payload_json: string;
  attempt: number;
  supersession_key: string | null;
}

export interface OutboxDispatcherOptions {
  maxAttempts: number;
  claimTtlMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  jitter?: (maximumMs: number) => number;
}

export interface DispatchOutcome {
  id: string;
  state: "sent" | "retry_scheduled" | "dead_letter" | "superseded";
  attempt: number;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

export class OutboxDispatcher {
  private readonly database: DatabaseSync;
  private readonly transport: OutboxDeliveryPort;
  private readonly options: OutboxDispatcherOptions;

  constructor(database: DatabaseSync, transport: OutboxDeliveryPort, options: OutboxDispatcherOptions) {
    this.database = database;
    this.transport = transport;
    this.options = options;
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) throw new Error("maxAttempts must be positive");
    if (options.claimTtlMs < 1 || options.baseBackoffMs < 1 || options.maxBackoffMs < options.baseBackoffMs) {
      throw new Error("Invalid outbox retry timings");
    }
  }

  async dispatchOne(instance: Pick<InstanceLease, "ownerId" | "fence">, now: number): Promise<DispatchOutcome | null> {
    const row = this.claim(instance, now);
    if (!row) return null;
    if (!this.isLatestClaim(instance, row, now)) return { id: row.id, state: "superseded", attempt: row.attempt };
    let result: Awaited<ReturnType<OutboxDeliveryPort["deliver"]>>;
    try {
      result = await this.transport.deliver({
        id: row.id,
        source: row.source,
        dedupeKey: row.dedupe_key,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        aggregateVersion: row.aggregate_version,
        kind: row.kind,
        payload: JSON.parse(row.payload_json) as CollaborationOutboxEntry["card"],
      });
    } catch (error) {
      result = { outcome: "unknown", error: message(error) };
    }
    return this.complete(instance, row, result, now);
  }

  private claim(instance: Pick<InstanceLease, "ownerId" | "fence">, now: number): DispatchRow | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, now);
      this.database.prepare(
        "UPDATE collaboration_outbox SET delivery_state = 'superseded', superseded_at = ?, " +
          "claim_owner = NULL, claim_fence = NULL, claim_expires_at = NULL " +
          "WHERE sent_at IS NULL AND superseded_at IS NULL AND supersession_key IS NOT NULL " +
          "AND EXISTS (SELECT 1 FROM collaboration_outbox newer " +
          "WHERE newer.supersession_key = collaboration_outbox.supersession_key " +
          "AND newer.aggregate_version > collaboration_outbox.aggregate_version " +
          "AND newer.superseded_at IS NULL)",
      ).run(now);
      const row = this.database
        .prepare(
          "SELECT candidate.id, candidate.source, candidate.dedupe_key, candidate.aggregate_type, " +
            "candidate.aggregate_id, candidate.aggregate_version, candidate.kind, candidate.payload_json, " +
            "candidate.attempt, candidate.supersession_key FROM collaboration_outbox candidate " +
            "WHERE candidate.sent_at IS NULL AND candidate.superseded_at IS NULL AND candidate.next_attempt_at <= ? " +
            "AND (candidate.delivery_state = 'pending' OR " +
            "(candidate.delivery_state = 'claimed' AND candidate.claim_expires_at <= ?)) " +
            "AND NOT EXISTS (SELECT 1 FROM collaboration_outbox blocker " +
            "WHERE blocker.id <> candidate.id AND blocker.supersession_key = candidate.supersession_key " +
            "AND blocker.claim_owner IS NOT NULL AND blocker.claim_expires_at > ?) " +
            "ORDER BY candidate.created_at, candidate.id LIMIT 1",
        )
        .get(now, now, now) as DispatchRow | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }
      const result = this.database
        .prepare(
          "UPDATE collaboration_outbox SET delivery_state = 'claimed', claim_owner = ?, claim_fence = ?, " +
            "claim_expires_at = ?, attempt = attempt + 1 " +
            "WHERE id = ? AND sent_at IS NULL AND superseded_at IS NULL " +
            "AND (delivery_state = 'pending' OR (delivery_state = 'claimed' AND claim_expires_at <= ?))",
        )
        .run(instance.ownerId, instance.fence, now + this.options.claimTtlMs, row.id, now);
      if (result.changes !== 1) throw new StaleFenceError("Outbox claim lost its compare-and-swap");
      this.database.exec("COMMIT");
      return { ...row, attempt: row.attempt + 1 };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private isLatestClaim(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    row: DispatchRow,
    now: number,
  ): boolean {
    assertCurrentInstanceLease(this.database, instance, now);
    const current = this.database
      .prepare(
        "SELECT 1 FROM collaboration_outbox current WHERE current.id = ? AND current.delivery_state = 'claimed' " +
          "AND current.claim_owner = ? AND current.claim_fence = ? AND current.claim_expires_at > ? " +
          "AND current.superseded_at IS NULL AND NOT EXISTS (SELECT 1 FROM collaboration_outbox newer " +
          "WHERE newer.supersession_key = current.supersession_key AND current.supersession_key IS NOT NULL " +
          "AND newer.aggregate_version > current.aggregate_version AND newer.superseded_at IS NULL)",
      )
      .get(row.id, instance.ownerId, instance.fence, now);
    if (current) return true;
    const updated = this.database
      .prepare(
        "UPDATE collaboration_outbox SET delivery_state = 'superseded', superseded_at = ?, " +
          "claim_owner = NULL, claim_fence = NULL, claim_expires_at = NULL " +
          "WHERE id = ? AND delivery_state = 'claimed' AND claim_owner = ? AND claim_fence = ?",
      )
      .run(now, row.id, instance.ownerId, instance.fence);
    if (updated.changes !== 1) throw new StaleFenceError("Outbox claim is stale");
    return false;
  }

  private complete(
    instance: Pick<InstanceLease, "ownerId" | "fence">,
    row: DispatchRow,
    result: Awaited<ReturnType<OutboxDeliveryPort["deliver"]>>,
    now: number,
  ): DispatchOutcome {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertCurrentInstanceLease(this.database, instance, now);
      let state: DispatchOutcome["state"];
      let update;
      if (result.outcome === "sent") {
        state = "sent";
        update = this.database.prepare(
          "UPDATE collaboration_outbox SET delivery_state = 'sent', sent_at = ?, last_error = NULL, " +
            "claim_owner = NULL, claim_fence = NULL, claim_expires_at = NULL " +
            "WHERE id = ? AND delivery_state = 'claimed' AND claim_owner = ? AND claim_fence = ? " +
            "AND claim_expires_at > ? AND superseded_at IS NULL",
        ).run(now, row.id, instance.ownerId, instance.fence, now);
      } else if (result.outcome === "permanent_failure" || row.attempt >= this.options.maxAttempts) {
        state = "dead_letter";
        update = this.database.prepare(
          "UPDATE collaboration_outbox SET delivery_state = 'dead_letter', dead_lettered_at = ?, last_error = ?, " +
            "claim_owner = NULL, claim_fence = NULL, claim_expires_at = NULL " +
            "WHERE id = ? AND delivery_state = 'claimed' AND claim_owner = ? AND claim_fence = ? " +
            "AND claim_expires_at > ? AND superseded_at IS NULL",
        ).run(now, result.error, row.id, instance.ownerId, instance.fence, now);
      } else {
        state = "retry_scheduled";
        const exponent = Math.min(this.options.maxBackoffMs, this.options.baseBackoffMs * 2 ** (row.attempt - 1));
        const jitter = Math.max(0, Math.min(exponent, this.options.jitter?.(exponent) ?? 0));
        update = this.database.prepare(
          "UPDATE collaboration_outbox SET delivery_state = 'pending', next_attempt_at = ?, last_error = ?, " +
            "claim_owner = NULL, claim_fence = NULL, claim_expires_at = NULL " +
            "WHERE id = ? AND delivery_state = 'claimed' AND claim_owner = ? AND claim_fence = ? " +
            "AND claim_expires_at > ? AND superseded_at IS NULL",
        ).run(now + exponent + jitter, result.error, row.id, instance.ownerId, instance.fence, now);
      }
      if (update.changes !== 1) {
        const superseded = this.database
          .prepare(
            "UPDATE collaboration_outbox SET claim_owner = NULL, claim_fence = NULL, claim_expires_at = NULL " +
              "WHERE id = ? AND delivery_state = 'superseded' AND claim_owner = ? AND claim_fence = ?",
          )
          .run(row.id, instance.ownerId, instance.fence);
        if (superseded.changes !== 1) throw new StaleFenceError("Outbox completion is stale");
        state = "superseded";
      }
      this.database.exec("COMMIT");
      return { id: row.id, state, attempt: row.attempt };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
