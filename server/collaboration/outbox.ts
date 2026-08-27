import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { InboundCard } from "./message-renderer.ts";

export interface CollaborationOutboxEntry {
  id: string;
  source: "dingtalk";
  sourceEventId: string;
  aggregateType: "work_item" | "association" | "plan";
  aggregateId: string;
  aggregateVersion: number;
  kind: InboundCard["type"];
  supersessionKey: string | null;
  card: InboundCard;
  createdAt: number;
  sentAt: number | null;
  deliveryState: "pending" | "claimed" | "sent" | "dead_letter" | "superseded";
  attempt: number;
  nextAttemptAt: number;
  lastError: string | null;
}

/** Transport-neutral contract implemented by the real DingTalk adapter. */
export interface OutboxDeliveryPort {
  deliver(message: {
    id: string;
    source: string;
    dedupeKey: string;
    aggregateType: CollaborationOutboxEntry["aggregateType"];
    aggregateId: string;
    aggregateVersion: number;
    kind: CollaborationOutboxEntry["kind"];
    payload: InboundCard;
  }): Promise<
    | { outcome: "sent"; transportId?: string }
    | { outcome: "retryable" | "unknown"; error: string }
    | { outcome: "permanent_failure"; error: string }
  >;
}

interface OutboxRow {
  id: string;
  source: "dingtalk";
  source_event_id: string;
  aggregate_type: "work_item" | "association" | "plan";
  aggregate_id: string;
  aggregate_version: number;
  kind: InboundCard["type"];
  supersession_key: string | null;
  payload_json: string;
  created_at: number;
  sent_at: number | null;
  superseded_at: number | null;
  delivery_state: CollaborationOutboxEntry["deliveryState"];
  attempt: number;
  next_attempt_at: number;
  last_error: string | null;
  dedupe_key: string;
}

function rowToEntry(row: OutboxRow): CollaborationOutboxEntry {
  return {
    id: row.id,
    source: row.source,
    sourceEventId: row.source_event_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    kind: row.kind,
    supersessionKey: row.supersession_key,
    card: JSON.parse(row.payload_json) as InboundCard,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    deliveryState: row.delivery_state,
    attempt: row.attempt,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
  };
}

export function enqueueInboundCard(
  database: DatabaseSync,
  input: {
    sourceEventId: string;
    aggregateType: "work_item" | "association" | "plan";
    aggregateId: string;
    aggregateVersion: number;
    card: InboundCard;
    supersessionKey?: string;
    now: number;
  },
): CollaborationOutboxEntry {
  const id = randomUUID();
  if (input.supersessionKey) {
    database
      .prepare(
        "UPDATE collaboration_outbox SET superseded_at = ?, delivery_state = 'superseded' " +
          "WHERE supersession_key = ? AND sent_at IS NULL AND superseded_at IS NULL",
      )
      .run(input.now, input.supersessionKey);
  }
  database
    .prepare(
      "INSERT INTO collaboration_outbox " +
        "(id, source, source_event_id, aggregate_type, aggregate_id, aggregate_version, kind, dedupe_key, " +
        "supersession_key, payload_json, created_at, next_attempt_at) " +
        "VALUES (?, 'dingtalk', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      input.sourceEventId,
      input.aggregateType,
      input.aggregateId,
      input.aggregateVersion,
      input.card.type,
      `dingtalk:event:${input.sourceEventId}:ack`,
      input.supersessionKey ?? null,
      JSON.stringify(input.card),
      input.now,
      input.now,
    );
  return {
    id,
    source: "dingtalk",
    sourceEventId: input.sourceEventId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    kind: input.card.type,
    supersessionKey: input.supersessionKey ?? null,
    card: input.card,
    createdAt: input.now,
    sentAt: null,
    deliveryState: "pending",
    attempt: 0,
    nextAttemptAt: input.now,
    lastError: null,
  };
}

export function outboxEntryForEvent(database: DatabaseSync, sourceEventId: string): CollaborationOutboxEntry {
  const row = database
    .prepare("SELECT * FROM collaboration_outbox WHERE source = 'dingtalk' AND source_event_id = ?")
    .get(sourceEventId) as OutboxRow | undefined;
  if (!row) throw new Error(`Missing acknowledgement outbox entry for ${sourceEventId}`);
  return rowToEntry(row);
}

export function listPendingOutbox(database: DatabaseSync): CollaborationOutboxEntry[] {
  const rows = database
    .prepare(
      "SELECT * FROM collaboration_outbox " +
        "WHERE delivery_state IN ('pending', 'claimed') AND sent_at IS NULL AND superseded_at IS NULL " +
          "ORDER BY created_at, id",
    )
    .all() as unknown as OutboxRow[];
  return rows.map(rowToEntry);
}
