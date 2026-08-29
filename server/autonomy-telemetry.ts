import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import type { JsonValue } from "./schema.ts";

const SAFE_METADATA_FIELDS = {
  provider: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  operation: z.string().trim().min(1).max(100).optional(),
  reasonCode: z.string().trim().min(1).max(100).optional(),
  region: z.string().trim().regex(/^[a-z]{2}(?:-[a-z0-9]+){1,3}$/).max(40).optional(),
  resourceType: z.string().trim().regex(/^[a-z][a-z0-9_.:-]{0,79}$/).optional(),
  resultCode: z.string().trim().regex(/^[a-z][a-z0-9_.:-]{0,79}$/).optional(),
  source: z.string().trim().min(1).max(100).optional(),
  environment: z.enum(["development", "test", "staging", "production"]).optional(),
  attempt: z.number().int().min(0).max(10_000).optional(),
  status: z.enum(["started", "succeeded", "failed", "cancelled", "unknown"]).optional(),
  service: z.string().trim().regex(/^[a-z][a-z0-9_.:-]{0,79}$/).optional(),
} as const;

const metadataSchema = z.object(SAFE_METADATA_FIELDS).strict();
export type TelemetryMetadata = z.infer<typeof metadataSchema>;

const opaqueIdSchema = z.string().trim().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const idempotencyKeySchema = z.string().trim().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const observedAtSchema = z.number().finite();
const metadataInput = metadataSchema.optional();
const commonInput = {
  workId: opaqueIdSchema,
  idempotencyKey: idempotencyKeySchema,
  observedAt: observedAtSchema.optional(),
  metadata: metadataInput,
};

const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("work.started"), ...commonInput, workScope: z.enum(["aws", "other"]).default("other") }),
  z.object({ type: z.literal("work.closed"), ...commonInput, closureKind: z.enum(["success", "cancelled", "blocked", "unknown"]) }),
  z.object({ type: z.literal("outcome.verified"), ...commonInput, evidenceRef: opaqueIdSchema }),
  z.object({ type: z.literal("human.touch"), ...commonInput, touchKind: z.enum(["review", "edit", "approval", "override", "escalation", "other"]) }),
  z.object({ type: z.literal("approval.requested"), ...commonInput, approvalKey: opaqueIdSchema }),
  z.object({ type: z.literal("approval.decided"), ...commonInput, approvalKey: opaqueIdSchema, decision: z.enum(["approved", "rejected", "revoked"]), actor: z.literal("human") }),
  z.object({ type: z.literal("interruption.classified"), ...commonInput, classification: z.enum(["false", "real", "unknown"]), reasonCode: opaqueIdSchema.optional() }),
  z.object({ type: z.literal("rework.recorded"), ...commonInput, reasonCode: opaqueIdSchema }),
  z.object({ type: z.literal("auth.failure"), ...commonInput, provider: opaqueIdSchema, service: opaqueIdSchema, failureCode: opaqueIdSchema }),
  z.object({ type: z.literal("cost.reference"), ...commonInput, source: z.enum(["provider_reported", "billing_export", "estimate", "unavailable"]), reference: opaqueIdSchema, amountUsd: z.number().finite().min(0).max(1_000_000_000).optional() }),
  z.object({ type: z.literal("coverage.asserted"), ...commonInput, coverageKind: z.literal("human_interactions"), coverageStatus: z.literal("complete") }),
]);
export type AutonomyTelemetryEventInput = z.input<typeof inputSchema>;

const outputCommon = {
  eventId: opaqueIdSchema,
  workId: opaqueIdSchema,
  idempotencyKey: idempotencyKeySchema,
  observedAt: observedAtSchema,
  metadata: metadataSchema.nullable(),
};
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("work.started"), ...outputCommon, workScope: z.enum(["aws", "other"]) }),
  z.object({ type: z.literal("work.closed"), ...outputCommon, closureKind: z.enum(["success", "cancelled", "blocked", "unknown"]) }),
  z.object({ type: z.literal("outcome.verified"), ...outputCommon, evidenceRef: opaqueIdSchema }),
  z.object({ type: z.literal("human.touch"), ...outputCommon, touchKind: z.enum(["review", "edit", "approval", "override", "escalation", "other"]) }),
  z.object({ type: z.literal("approval.requested"), ...outputCommon, approvalKey: opaqueIdSchema }),
  z.object({ type: z.literal("approval.decided"), ...outputCommon, approvalKey: opaqueIdSchema, decision: z.enum(["approved", "rejected", "revoked"]), actor: z.literal("human") }),
  z.object({ type: z.literal("interruption.classified"), ...outputCommon, classification: z.enum(["false", "real", "unknown"]), reasonCode: opaqueIdSchema.optional() }),
  z.object({ type: z.literal("rework.recorded"), ...outputCommon, reasonCode: opaqueIdSchema }),
  z.object({ type: z.literal("auth.failure"), ...outputCommon, provider: opaqueIdSchema, service: opaqueIdSchema, failureCode: opaqueIdSchema }),
  z.object({ type: z.literal("cost.reference"), ...outputCommon, source: z.enum(["provider_reported", "billing_export", "estimate", "unavailable"]), reference: opaqueIdSchema, amountUsd: z.number().finite().min(0).max(1_000_000_000).optional() }),
  z.object({ type: z.literal("coverage.asserted"), ...outputCommon, coverageKind: z.literal("human_interactions"), coverageStatus: z.literal("complete") }),
]);
export type AutonomyTelemetryEvent = z.infer<typeof eventSchema>;

export interface AutonomyTelemetrySummary {
  retainedEvents: number;
  observedWorkCount: number;
  closedWorkCount: number;
  verifiedOutcomeCount: number;
  verifiedOutcomeRate: number | null;
  humanTouchCount: number | null;
  approvalRequestCount: number | null;
  humanApprovalDecisionCount: number | null;
  interruptionClassificationCount: number | null;
  falseInterruptionCount: number | null;
  falseInterruptionRate: number | null;
  reworkCount: number | null;
  authFailureCount: number | null;
  timeToCloseMs: { count: number; median: number | null };
  cost: { referenceCount: number; reportedUsd: number | null; estimatedUsd: number | null; unavailableUsdReferences: number | null };
  /**
   * Numerator = verified, successful AWS work with no observed human touch or
   * human approval decision. Denominator = all verified, successful AWS work.
   * Both are null unless complete human-interaction coverage was explicitly
   * asserted for every denominator candidate.
   */
  awsAutonomousVerifiedShare: {
    numerator: number | null;
    denominator: number | null;
    value: number | null;
    coverage: "complete" | "partial" | "unavailable";
  };
  retention: { maxEvents: number; truncated: boolean };
}

export interface AutonomyTelemetryRecordResult {
  status: "recorded" | "deduplicated";
  event: AutonomyTelemetryEvent;
}

export interface AutonomyTelemetryInterface {
  record(input: AutonomyTelemetryEventInput): AutonomyTelemetryRecordResult;
  list(options?: { since?: number; until?: number; limit?: number }): AutonomyTelemetryEvent[];
  summary(options?: { since?: number; until?: number }): AutonomyTelemetrySummary;
  close(): void;
}

export class AutonomyTelemetryError extends Error {
  readonly code: "idempotency_conflict";

  constructor(message: string) {
    super(message);
    this.name = "AutonomyTelemetryError";
    this.code = "idempotency_conflict";
  }
}

const eventRowSchema = z.object({
  event_id: z.string(),
  idempotency_key: z.string(),
  request_hash: z.string(),
  event_json: z.string(),
});

const countRowSchema = z.object({ count: z.number() });
const retentionRowSchema = z.object({ value: z.string() });

function stableJson(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const primitive = z.union([z.string(), z.number(), z.boolean()]).safeParse(value);
  if (primitive.success) return JSON.stringify(primitive.data);
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function finiteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] ?? null : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * A bounded, append-only observation ledger for autonomy claims. Every metric
 * is derived from an explicit event; absent evidence remains null. Payloads
 * contain only allow-listed operational metadata, never transcript content or
 * credentials.
 */
export class AutonomyTelemetry implements AutonomyTelemetryInterface {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly maxEvents: number;

  constructor(options: { file?: string; now?: () => number; maxEvents?: number } = {}) {
    const file = options.file ?? join(DATA_DIR, "autonomy-telemetry.db");
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.now = options.now ?? Date.now;
    this.maxEvents = Math.max(1, Math.min(100_000, Math.trunc(options.maxEvents ?? 10_000)));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_telemetry_events (
        event_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        work_id TEXT NOT NULL,
        observed_at REAL NOT NULL,
        request_hash TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS autonomy_telemetry_observed ON autonomy_telemetry_events(observed_at ASC, event_id ASC);
      CREATE TABLE IF NOT EXISTS autonomy_telemetry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  record(raw: AutonomyTelemetryEventInput): AutonomyTelemetryRecordResult {
    const input = inputSchema.parse(raw);
    const requestHash = hash(stableJson(input));
    const existing = this.db.prepare("SELECT event_id, idempotency_key, request_hash, event_json FROM autonomy_telemetry_events WHERE idempotency_key = ?").get(input.idempotencyKey);
    if (existing !== undefined) {
      const row = eventRowSchema.parse(existing);
      if (row.request_hash !== requestHash) throw new AutonomyTelemetryError(`Idempotency key already belongs to a different telemetry event: ${input.idempotencyKey}`);
      return { status: "deduplicated", event: eventSchema.parse(JSON.parse(row.event_json)) };
    }
    const observedAt = input.observedAt ?? this.now();
    const eventId = `omb_telemetry_${hash(`${input.idempotencyKey}\u001f${requestHash}`).slice(0, 48)}`;
    const event = eventSchema.parse({ ...input, eventId, observedAt, metadata: input.metadata ?? null });
    this.transaction(() => {
      this.db.prepare("INSERT INTO autonomy_telemetry_events (event_id, idempotency_key, event_type, work_id, observed_at, request_hash, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(event.eventId, event.idempotencyKey, event.type, event.workId, event.observedAt, requestHash, stableJson(event));
      const count = countRowSchema.parse(this.db.prepare("SELECT COUNT(*) AS count FROM autonomy_telemetry_events").get()).count;
      const excess = count - this.maxEvents;
      if (excess > 0) {
        this.db.prepare("DELETE FROM autonomy_telemetry_events WHERE event_id IN (SELECT event_id FROM autonomy_telemetry_events ORDER BY observed_at ASC, event_id ASC LIMIT ?)").run(excess);
        this.db.prepare("INSERT INTO autonomy_telemetry_meta (key, value) VALUES ('truncated', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
      }
    });
    return { status: "recorded", event };
  }

  list(options: { since?: number; until?: number; limit?: number } = {}): AutonomyTelemetryEvent[] {
    const clauses: string[] = [];
    const values: Array<number> = [];
    if (finiteNumber(options.since)) { clauses.push("observed_at >= ?"); values.push(options.since); }
    if (finiteNumber(options.until)) { clauses.push("observed_at <= ?"); values.push(options.until); }
    const limit = Math.max(1, Math.min(this.maxEvents, Math.trunc(options.limit ?? this.maxEvents)));
    values.push(limit);
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = this.db.prepare(`SELECT event_json FROM autonomy_telemetry_events ${where} ORDER BY observed_at ASC, event_id ASC LIMIT ?`).all(...values);
    return rows.map((row) => eventSchema.parse(JSON.parse(z.object({ event_json: z.string() }).parse(row).event_json)));
  }

  summary(options: { since?: number; until?: number } = {}): AutonomyTelemetrySummary {
    const events = this.list(options);
    const workIds = new Set(events.map((event) => event.workId));
    const closedWorkIds = new Set(events.filter((event): event is Extract<AutonomyTelemetryEvent, { type: "work.closed" }> => event.type === "work.closed").map((event) => event.workId));
    const verifiedWorkIds = new Set(events.filter((event): event is Extract<AutonomyTelemetryEvent, { type: "outcome.verified" }> => event.type === "outcome.verified").map((event) => event.workId));
    const verifiedClosedCount = [...verifiedWorkIds].filter((workId) => closedWorkIds.has(workId)).length;
    const awsWorkIds = new Set(events.filter((event): event is Extract<AutonomyTelemetryEvent, { type: "work.started" }> => event.type === "work.started" && event.workScope === "aws").map((event) => event.workId));
    const awsSuccessfulVerifiedWorkIds = new Set(events
      .filter((event): event is Extract<AutonomyTelemetryEvent, { type: "work.closed" }> => event.type === "work.closed" && event.closureKind === "success")
      .map((event) => event.workId)
      .filter((workId) => awsWorkIds.has(workId) && verifiedWorkIds.has(workId)));
    const completeCoverageWorkIds = new Set(events
      .filter((event): event is Extract<AutonomyTelemetryEvent, { type: "coverage.asserted" }> => event.type === "coverage.asserted" && event.coverageKind === "human_interactions" && event.coverageStatus === "complete")
      .map((event) => event.workId));
    const awsCoverageComplete = awsSuccessfulVerifiedWorkIds.size > 0 && [...awsSuccessfulVerifiedWorkIds].every((workId) => completeCoverageWorkIds.has(workId));
    const awsCoveragePartial = awsSuccessfulVerifiedWorkIds.size > 0 && !awsCoverageComplete;
    const humanInteractedWorkIds = new Set(events
      .filter((event): event is Extract<AutonomyTelemetryEvent, { type: "human.touch" }> => event.type === "human.touch")
      .map((event) => event.workId));
    const humanApprovedWorkIds = new Set(events
      .filter((event): event is Extract<AutonomyTelemetryEvent, { type: "approval.decided" }> => event.type === "approval.decided" && event.actor === "human")
      .map((event) => event.workId));
    const autonomousAwsCount = [...awsSuccessfulVerifiedWorkIds]
      .filter((workId) => !humanInteractedWorkIds.has(workId) && !humanApprovedWorkIds.has(workId)).length;
    const starts = new Map<string, number>();
    const closeDurations: number[] = [];
    for (const event of events) {
      if (event.type === "work.started" && !starts.has(event.workId)) starts.set(event.workId, event.observedAt);
      if (event.type === "work.closed" && starts.has(event.workId)) {
        const startedAt = starts.get(event.workId);
        if (startedAt !== undefined && event.observedAt >= startedAt) closeDurations.push(event.observedAt - startedAt);
      }
    }
    const interruptions = events.filter((event): event is Extract<AutonomyTelemetryEvent, { type: "interruption.classified" }> => event.type === "interruption.classified");
    const costs = events.filter((event): event is Extract<AutonomyTelemetryEvent, { type: "cost.reference" }> => event.type === "cost.reference");
    const reportedCosts = costs.filter((event) => event.source === "provider_reported" || event.source === "billing_export").map((event) => event.amountUsd).filter((value): value is number => finiteNumber(value));
    const estimatedCosts = costs.filter((event) => event.source === "estimate").map((event) => event.amountUsd).filter((value): value is number => finiteNumber(value));
    const unavailableCosts = costs.filter((event) => event.source === "unavailable" || !finiteNumber(event.amountUsd)).length;
    const countOrNull = (count: number): number | null => count === 0 ? null : count;
    const truncated = this.db.prepare("SELECT value FROM autonomy_telemetry_meta WHERE key = 'truncated'").get();
    const isTruncated = truncated === undefined ? false : retentionRowSchema.parse(truncated).value === "1";
    return {
      retainedEvents: events.length,
      observedWorkCount: workIds.size,
      closedWorkCount: closedWorkIds.size,
      verifiedOutcomeCount: verifiedWorkIds.size,
      verifiedOutcomeRate: closedWorkIds.size === 0 ? null : verifiedClosedCount / closedWorkIds.size,
      humanTouchCount: countOrNull(events.filter((event) => event.type === "human.touch").length),
      approvalRequestCount: countOrNull(events.filter((event) => event.type === "approval.requested").length),
      humanApprovalDecisionCount: countOrNull(events.filter((event) => event.type === "approval.decided").length),
      interruptionClassificationCount: countOrNull(interruptions.length),
      falseInterruptionCount: countOrNull(interruptions.filter((event) => event.classification === "false").length),
      falseInterruptionRate: interruptions.length === 0 ? null : interruptions.filter((event) => event.classification === "false").length / interruptions.length,
      reworkCount: countOrNull(events.filter((event) => event.type === "rework.recorded").length),
      authFailureCount: countOrNull(events.filter((event) => event.type === "auth.failure").length),
      timeToCloseMs: { count: closeDurations.length, median: median(closeDurations) },
      cost: {
        referenceCount: costs.length,
        reportedUsd: reportedCosts.length === 0 ? null : reportedCosts.reduce((total, amount) => total + amount, 0),
        estimatedUsd: estimatedCosts.length === 0 ? null : estimatedCosts.reduce((total, amount) => total + amount, 0),
        unavailableUsdReferences: unavailableCosts === 0 ? null : unavailableCosts,
      },
      awsAutonomousVerifiedShare: {
        numerator: awsCoverageComplete ? autonomousAwsCount : null,
        denominator: awsCoverageComplete ? awsSuccessfulVerifiedWorkIds.size : null,
        value: awsCoverageComplete ? autonomousAwsCount / awsSuccessfulVerifiedWorkIds.size : null,
        coverage: awsCoverageComplete ? "complete" : awsCoveragePartial ? "partial" : "unavailable",
      },
      retention: { maxEvents: this.maxEvents, truncated: isTruncated },
    };
  }

  close(): void { this.db.close(); }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
