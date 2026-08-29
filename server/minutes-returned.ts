import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import type { AutonomyTelemetryInterface } from "./autonomy-telemetry.ts";
import type { JsonValue } from "./schema.ts";
import type { WorkLockStoreInterface } from "./work-lock-store.ts";

/**
 * Value accounting for completed work. This is deliberately a ledger, not a
 * second work board: work must already exist in WorkLockStore, and the only
 * stored text is typed operational metadata (never prompts or transcripts).
 */
export const RESIDUAL_INTERVENTION_KINDS = [
  "none",
  "review",
  "approval",
  "edit",
  "exception",
  "supervision",
  "authentication",
  "rework",
  "other",
] as const;
export type ResidualInterventionKind = (typeof RESIDUAL_INTERVENTION_KINDS)[number];

export const OUTCOME_KINDS = ["qualified", "health_check", "empty_sweep", "unknown"] as const;
export type MinutesReturnedOutcomeKind = (typeof OUTCOME_KINDS)[number];

const taskClassSchema = z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9._:-]*$/);
const idempotencyKeySchema = z.string().trim().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const finiteNonNegative = z.number().finite().min(0).max(1_000_000);
export interface MinutesReturnedTaskClass {
  taskClass: string;
  manualMinutes: number;
  updatedAt: number;
}

export interface ResidualIntervention {
  kind: ResidualInterventionKind;
  minutes: number;
}

export interface MinutesReturnedOutcome {
  id: string;
  workId: string;
  taskClass: string;
  outcomeKind: MinutesReturnedOutcomeKind;
  manualMinutes: number;
  residualMinutes: number;
  minutesReturned: number;
  status: "pending" | "settled";
  submittedAt: number;
  settlesAt: number;
  settledAt: number | null;
  residualInterventions: ResidualIntervention[];
}

export interface MinutesReturnedTaskSummary {
  taskClass: string;
  outcomeCount: number;
  pendingOutcomeCount: number;
  settledOutcomeCount: number;
  minutesReturned: number | null;
  minutesInvested: number | null;
  multiplier: number | null;
  investmentCoverage: "complete" | "partial" | "unavailable";
  residualInterventions: Array<{ kind: ResidualInterventionKind; count: number; minutes: number }>;
}

export interface MinutesReturnedSummary {
  outcomeCount: number;
  pendingOutcomeCount: number;
  settledOutcomeCount: number;
  minutesReturned: number | null;
  minutesInvested: number | null;
  multiplier: number | null;
  investmentCoverage: "complete" | "partial" | "unavailable";
  byTaskClass: MinutesReturnedTaskSummary[];
}

export interface MinutesReturnedOutcomeResult {
  status: "recorded" | "deduplicated";
  outcome: MinutesReturnedOutcome;
}

export interface MinutesReturnedObservationResult {
  status: "recorded" | "deduplicated";
}

export interface MinutesReturnedLedgerInterface {
  configureTaskClass(input: { taskClass: string; manualMinutes: number }): MinutesReturnedTaskClass;
  listTaskClasses(): MinutesReturnedTaskClass[];
  recordOutcome(input: {
    workId: string;
    taskClass: string;
    outcomeKind: MinutesReturnedOutcomeKind;
    residualInterventions: ResidualIntervention[];
    idempotencyKey: string;
    submittedAt?: number;
  }): MinutesReturnedOutcomeResult;
  recordInvestment(input: { outcomeId: string; minutes: number; idempotencyKey: string; observedAt?: number }): MinutesReturnedObservationResult;
  recordAdjustment(input: { outcomeId: string; kind: "reversal" | "rework"; minutes: number; idempotencyKey: string; observedAt?: number }): MinutesReturnedObservationResult;
  settleDue(now?: number): MinutesReturnedOutcome[];
  summary(options?: { since?: number; until?: number }): MinutesReturnedSummary;
  close(): void;
}

export class MinutesReturnedError extends Error {
  readonly code: "invalid" | "not_found" | "not_completed" | "duplicate_conflict";

  constructor(code: MinutesReturnedError["code"], message: string) {
    super(message);
    this.name = "MinutesReturnedError";
    this.code = code;
  }
}

const classInputSchema = z.object({ taskClass: taskClassSchema, manualMinutes: finiteNonNegative.refine((value) => value > 0, "manualMinutes must be greater than zero") });
const outcomeInputSchema = z.object({
  workId: z.string().trim().min(1).max(300),
  taskClass: taskClassSchema,
  outcomeKind: z.enum(OUTCOME_KINDS),
  residualInterventions: z.array(z.object({ kind: z.enum(RESIDUAL_INTERVENTION_KINDS), minutes: finiteNonNegative })).max(30),
  idempotencyKey: idempotencyKeySchema,
  submittedAt: z.number().finite().optional(),
});

const outcomeRowSchema = z.object({
  id: z.string(), work_id: z.string(), task_class: z.string(), outcome_kind: z.enum(OUTCOME_KINDS), manual_minutes: z.number(), residual_minutes: z.number(), minutes_returned: z.number(), status: z.enum(["pending", "settled"]), submitted_at: z.number(), settles_at: z.number(), settled_at: z.number().nullable(), request_hash: z.string(), idempotency_key: z.string(),
});

const classRowSchema = z.object({ task_class: z.string(), manual_minutes: z.number(), updated_at: z.number() });
const adjustmentRowSchema = z.object({ kind: z.enum(["reversal", "rework"]), minutes: z.number() });
const interventionRowSchema = z.object({ kind: z.enum(RESIDUAL_INTERVENTION_KINDS), minutes: z.number() });

function stableJson(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const primitive = z.union([z.string(), z.number(), z.boolean()]).safeParse(value);
  if (primitive.success) return JSON.stringify(primitive.data);
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function idFor(prefix: string, key: string): string { return `omb_minutes_${prefix}_${hash(key).slice(0, 48)}`; }
function finite(value: number | undefined): value is number { return value !== undefined && Number.isFinite(value); }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }

export class MinutesReturnedLedger implements MinutesReturnedLedgerInterface {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly workLocks: WorkLockStoreInterface;
  private readonly telemetry?: AutonomyTelemetryInterface;
  private readonly settlementWindowMs: number;

  constructor(options: { file?: string; now?: () => number; workLocks: WorkLockStoreInterface; telemetry?: AutonomyTelemetryInterface; settlementWindowMs?: number }) {
    const file = options.file ?? join(DATA_DIR, "minutes-returned.db");
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.now = options.now ?? Date.now;
    this.workLocks = options.workLocks;
    this.telemetry = options.telemetry;
    this.settlementWindowMs = Math.max(1, Math.trunc(options.settlementWindowMs ?? 72 * 60 * 60 * 1_000));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS minutes_task_classes (task_class TEXT PRIMARY KEY, manual_minutes REAL NOT NULL CHECK(manual_minutes > 0), updated_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS minutes_outcomes (
        id TEXT PRIMARY KEY, work_id TEXT NOT NULL, task_class TEXT NOT NULL, outcome_kind TEXT NOT NULL,
        manual_minutes REAL NOT NULL, residual_minutes REAL NOT NULL, minutes_returned REAL NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'settled')), submitted_at REAL NOT NULL,
        settles_at REAL NOT NULL, settled_at REAL, request_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS minutes_outcomes_settled ON minutes_outcomes(settled_at, task_class);
      CREATE TABLE IF NOT EXISTS minutes_residuals (outcome_id TEXT NOT NULL REFERENCES minutes_outcomes(id), kind TEXT NOT NULL, minutes REAL NOT NULL, PRIMARY KEY(outcome_id, kind));
      CREATE TABLE IF NOT EXISTS minutes_investments (id TEXT PRIMARY KEY, outcome_id TEXT NOT NULL REFERENCES minutes_outcomes(id), minutes REAL NOT NULL, observed_at REAL NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS minutes_adjustments (id TEXT PRIMARY KEY, outcome_id TEXT NOT NULL REFERENCES minutes_outcomes(id), kind TEXT NOT NULL, minutes REAL NOT NULL, observed_at REAL NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS minutes_observation_keys (idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL);
    `);
  }

  configureTaskClass(raw: { taskClass: string; manualMinutes: number }): MinutesReturnedTaskClass {
    const input = classInputSchema.parse(raw);
    const now = this.now();
    this.db.prepare("INSERT INTO minutes_task_classes (task_class, manual_minutes, updated_at) VALUES (?, ?, ?) ON CONFLICT(task_class) DO UPDATE SET manual_minutes = excluded.manual_minutes, updated_at = excluded.updated_at").run(input.taskClass, input.manualMinutes, now);
    return { taskClass: input.taskClass, manualMinutes: input.manualMinutes, updatedAt: now };
  }

  listTaskClasses(): MinutesReturnedTaskClass[] {
    return this.db.prepare("SELECT task_class, manual_minutes, updated_at FROM minutes_task_classes ORDER BY task_class").all().map((row) => {
      const parsed = classRowSchema.parse(row);
      return { taskClass: parsed.task_class, manualMinutes: parsed.manual_minutes, updatedAt: parsed.updated_at };
    });
  }

  recordOutcome(raw: Parameters<MinutesReturnedLedgerInterface["recordOutcome"]>[0]): MinutesReturnedOutcomeResult {
    const input = outcomeInputSchema.parse(raw);
    const requestHash = hash(stableJson(input));
    const existing = this.db.prepare("SELECT * FROM minutes_outcomes WHERE idempotency_key = ?").get(input.idempotencyKey);
    if (existing !== undefined) {
      const row = outcomeRowSchema.parse(existing);
      if (row.request_hash !== requestHash) throw new MinutesReturnedError("duplicate_conflict", `Idempotency key already belongs to another outcome: ${input.idempotencyKey}`);
      return { status: "deduplicated", outcome: this.readOutcome(row.id) };
    }
    const obligation = this.workLocks.getObligation(input.workId);
    if (obligation === null) throw new MinutesReturnedError("not_found", `Work lock not found: ${input.workId}`);
    if (obligation.status !== "completed") throw new MinutesReturnedError("not_completed", "Minutes can be credited only after WorkLockStore marks the work completed with evidence");
    const configured = this.db.prepare("SELECT manual_minutes FROM minutes_task_classes WHERE task_class = ?").get(input.taskClass);
    if (configured === undefined && input.outcomeKind === "qualified") throw new MinutesReturnedError("invalid", `No manual-minute price is configured for task class: ${input.taskClass}`);
    const manualMinutes = configured === undefined ? 0 : z.object({ manual_minutes: z.number().positive() }).parse(configured).manual_minutes;
    const residualMinutes = sum(input.residualInterventions.map((item) => item.minutes));
    const submittedAt = input.submittedAt ?? this.now();
    const id = idFor("outcome", input.idempotencyKey);
    const settlesAt = submittedAt + this.settlementWindowMs;
    this.transaction(() => {
      this.db.prepare("INSERT INTO minutes_outcomes (id, work_id, task_class, outcome_kind, manual_minutes, residual_minutes, minutes_returned, status, submitted_at, settles_at, settled_at, request_hash, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?)").run(id, input.workId, input.taskClass, input.outcomeKind, manualMinutes, residualMinutes, manualMinutes - residualMinutes, submittedAt, settlesAt, requestHash, input.idempotencyKey);
      for (const intervention of input.residualInterventions) this.db.prepare("INSERT INTO minutes_residuals (outcome_id, kind, minutes) VALUES (?, ?, ?) ON CONFLICT(outcome_id, kind) DO UPDATE SET minutes = minutes + excluded.minutes").run(id, intervention.kind, intervention.minutes);
    });
    return { status: "recorded", outcome: this.readOutcome(id) };
  }

  recordInvestment(raw: Parameters<MinutesReturnedLedgerInterface["recordInvestment"]>[0]): MinutesReturnedObservationResult {
    const schema = z.object({ outcomeId: z.string().trim().min(1).max(300), minutes: finiteNonNegative, idempotencyKey: idempotencyKeySchema, observedAt: z.number().finite().optional() });
    const input = schema.parse(raw);
    if (this.db.prepare("SELECT id FROM minutes_outcomes WHERE id = ?").get(input.outcomeId) === undefined) throw new MinutesReturnedError("not_found", `Outcome not found: ${input.outcomeId}`);
    return this.insertObservation("minutes_investments", input.outcomeId, input.minutes, input.idempotencyKey, input.observedAt ?? this.now(), "investment", input.observedAt);
  }

  recordAdjustment(raw: Parameters<MinutesReturnedLedgerInterface["recordAdjustment"]>[0]): MinutesReturnedObservationResult {
    const schema = z.object({ outcomeId: z.string().trim().min(1).max(300), kind: z.enum(["reversal", "rework"]), minutes: finiteNonNegative.refine((value) => value > 0), idempotencyKey: idempotencyKeySchema, observedAt: z.number().finite().optional() });
    const input = schema.parse(raw);
    if (this.db.prepare("SELECT id FROM minutes_outcomes WHERE id = ?").get(input.outcomeId) === undefined) throw new MinutesReturnedError("not_found", `Outcome not found: ${input.outcomeId}`);
    return this.insertObservation("minutes_adjustments", input.outcomeId, input.minutes, input.idempotencyKey, input.observedAt ?? this.now(), input.kind, input.observedAt);
  }

  settleDue(at = this.now()): MinutesReturnedOutcome[] {
    const due = this.db.prepare("SELECT id FROM minutes_outcomes WHERE status = 'pending' AND settles_at <= ? ORDER BY settles_at, id").all(at).map((row) => z.object({ id: z.string() }).parse(row).id);
    if (due.length === 0) return [];
    // Emit the idempotent verification receipt first. If the process dies
    // before the status update, the next supervisor pass safely retries this
    // same receipt rather than silently losing the evidence.
    const dueOutcomes = due.map((id) => this.readOutcome(id));
    for (const outcome of dueOutcomes) {
      if (outcome.outcomeKind !== "qualified") continue;
      this.telemetry?.record({ type: "outcome.verified", workId: outcome.workId, idempotencyKey: `minutes-returned:verified:${outcome.id}`, evidenceRef: `minutes-returned:${outcome.id}`, observedAt: outcome.settledAt ?? at, metadata: { resourceType: "minutes_returned", status: "succeeded" } });
    }
    this.transaction(() => {
      for (const id of due) this.db.prepare("UPDATE minutes_outcomes SET status = 'settled', settled_at = ? WHERE id = ? AND status = 'pending'").run(at, id);
    });
    return due.map((id) => this.readOutcome(id));
  }

  summary(options: { since?: number; until?: number } = {}): MinutesReturnedSummary {
    this.settleDue();
    const rows = this.db.prepare("SELECT * FROM minutes_outcomes ORDER BY task_class, submitted_at, id").all().map((row) => outcomeRowSchema.parse(row));
    const since = finite(options.since) ? options.since : Number.NEGATIVE_INFINITY;
    const until = finite(options.until) ? options.until : Number.POSITIVE_INFINITY;
    const outcomes = rows.filter((row) => row.submitted_at >= since && row.submitted_at <= until);
    const classes = [...new Set(outcomes.map((row) => row.task_class))].sort();
    const byTaskClass = classes.map((taskClass) => this.summarizeClass(taskClass, outcomes.filter((row) => row.task_class === taskClass)));
    return this.summarizeTotals(outcomes, byTaskClass);
  }

  close(): void { this.db.close(); }

  private summarizeClass(taskClass: string, rows: z.infer<typeof outcomeRowSchema>[]): MinutesReturnedTaskSummary {
    const settled = rows.filter((row) => row.status === "settled");
    const eligible = settled.filter((row) => row.outcome_kind === "qualified");
    const investments = this.investmentTotals(eligible.map((row) => row.id));
    const observedCount = eligible.filter((row) => investments.has(row.id)).length;
    const coverage = eligible.length === 0 ? "unavailable" : observedCount === eligible.length ? "complete" : observedCount === 0 ? "unavailable" : "partial";
    const returned = eligible.length === 0 ? null : sum(eligible.map((row) => this.currentCredit(row.id, row.minutes_returned)));
    const invested = investments.size === 0 ? null : sum([...investments.values()]);
    const multiplier = coverage === "complete" && invested !== null && invested > 0 && returned !== null ? returned / invested : null;
    const interventionMap = new Map<ResidualInterventionKind, { count: number; minutes: number }>();
    for (const row of eligible) for (const intervention of this.readInterventions(row.id)) {
      const existing = interventionMap.get(intervention.kind) ?? { count: 0, minutes: 0 };
      interventionMap.set(intervention.kind, { count: existing.count + 1, minutes: existing.minutes + intervention.minutes });
    }
    return { taskClass, outcomeCount: rows.length, pendingOutcomeCount: rows.length - settled.length, settledOutcomeCount: settled.length, minutesReturned: returned, minutesInvested: invested, multiplier, investmentCoverage: coverage, residualInterventions: [...interventionMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, value]) => ({ kind, ...value })) };
  }

  private summarizeTotals(rows: z.infer<typeof outcomeRowSchema>[], byTaskClass: MinutesReturnedTaskSummary[]): MinutesReturnedSummary {
    const settled = rows.filter((row) => row.status === "settled");
    const eligible = settled.filter((row) => row.outcome_kind === "qualified");
    const minutesReturned = eligible.length === 0 ? null : sum(eligible.map((row) => this.currentCredit(row.id, row.minutes_returned)));
    const investments = this.investmentTotals(eligible.map((row) => row.id));
    const minutesInvested = investments.size === 0 ? null : sum([...investments.values()]);
    const observedCount = eligible.filter((row) => investments.has(row.id)).length;
    const investmentCoverage = eligible.length === 0 ? "unavailable" : observedCount === eligible.length ? "complete" : observedCount === 0 ? "unavailable" : "partial";
    return { outcomeCount: rows.length, pendingOutcomeCount: rows.length - settled.length, settledOutcomeCount: settled.length, minutesReturned, minutesInvested, multiplier: investmentCoverage === "complete" && minutesInvested !== null && minutesInvested > 0 && minutesReturned !== null ? minutesReturned / minutesInvested : null, investmentCoverage, byTaskClass };
  }

  private readOutcome(id: string): MinutesReturnedOutcome {
    const row = outcomeRowSchema.parse(this.db.prepare("SELECT * FROM minutes_outcomes WHERE id = ?").get(id));
    return { id: row.id, workId: row.work_id, taskClass: row.task_class, outcomeKind: row.outcome_kind, manualMinutes: row.manual_minutes, residualMinutes: row.residual_minutes, minutesReturned: this.currentCredit(row.id, row.minutes_returned), status: row.status, submittedAt: row.submitted_at, settlesAt: row.settles_at, settledAt: row.settled_at, residualInterventions: this.readInterventions(row.id) };
  }

  private readInterventions(outcomeId: string): ResidualIntervention[] {
    return this.db.prepare("SELECT kind, minutes FROM minutes_residuals WHERE outcome_id = ? ORDER BY kind").all(outcomeId).map((row) => interventionRowSchema.parse(row)).map((row) => ({ kind: row.kind, minutes: row.minutes }));
  }

  private currentCredit(outcomeId: string, base: number): number {
    const adjustments = this.db.prepare("SELECT kind, minutes FROM minutes_adjustments WHERE outcome_id = ?").all(outcomeId).map((row) => adjustmentRowSchema.parse(row));
    return base - sum(adjustments.map((adjustment) => adjustment.minutes));
  }

  private investmentTotals(outcomeIds: string[]): Map<string, number> {
    const result = new Map<string, number>();
    for (const outcomeId of outcomeIds) {
      const row = this.db.prepare("SELECT COALESCE(SUM(minutes), 0) AS minutes, COUNT(*) AS count FROM minutes_investments WHERE outcome_id = ?").get(outcomeId);
      const parsed = z.object({ minutes: z.number(), count: z.number() }).parse(row);
      if (parsed.count > 0) result.set(outcomeId, parsed.minutes);
    }
    return result;
  }

  private insertObservation(table: "minutes_investments" | "minutes_adjustments", outcomeId: string, minutes: number, idempotencyKey: string, observedAt: number, kind: "investment" | "reversal" | "rework", explicitObservedAt?: number): MinutesReturnedObservationResult {
    const requestPayload: JsonValue = { outcomeId, minutes, idempotencyKey, kind };
    if (explicitObservedAt !== undefined) requestPayload.observedAt = explicitObservedAt;
    const requestHash = hash(stableJson(requestPayload));
    const existing = this.db.prepare("SELECT request_hash FROM minutes_observation_keys WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing !== undefined) {
      const row = z.object({ request_hash: z.string() }).parse(existing);
      if (row.request_hash !== requestHash) throw new MinutesReturnedError("duplicate_conflict", `Idempotency key already belongs to another accounting observation: ${idempotencyKey}`);
      return { status: "deduplicated" };
    }
    const id = idFor(kind, idempotencyKey);
    this.transaction(() => {
      this.db.prepare("INSERT INTO minutes_observation_keys (idempotency_key, request_hash) VALUES (?, ?)").run(idempotencyKey, requestHash);
      if (table === "minutes_investments") this.db.prepare("INSERT INTO minutes_investments (id, outcome_id, minutes, observed_at, idempotency_key, request_hash) VALUES (?, ?, ?, ?, ?, ?)").run(id, outcomeId, minutes, observedAt, idempotencyKey, requestHash);
      else this.db.prepare("INSERT INTO minutes_adjustments (id, outcome_id, kind, minutes, observed_at, idempotency_key, request_hash) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, outcomeId, kind, minutes, observedAt, idempotencyKey, requestHash);
    });
    return { status: "recorded" };
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
