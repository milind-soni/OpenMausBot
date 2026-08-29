import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import {
  CaptureLedger,
  type CaptureKind,
  type CaptureReceipt,
  type CaptureSourceHealthSnapshot,
} from "./capture-ledger.ts";
import { createChangeMarkerPreflight, type Routine, type RoutineRun } from "./routines.ts";

export type CaptureSupervisorTrigger = "push" | "quiet" | "startup" | "manual";
export type CaptureSupervisorStrategy = "normal" | "changed";

/** A retry is only allowed when the collector explicitly says that no
 * ambiguous side effect occurred. Thrown errors are intentionally terminal
 * for this tick: replaying an unknown outcome is unsafe. */
export type CaptureSupervisorExecution =
  | { status: "completed"; receipt: CaptureReceipt }
  | { status: "retryable"; reason: string };

type CaptureSupervisorInvocation = CaptureSupervisorExecution | { status: "failed"; error: string };

export interface CaptureSupervisorExecuteInput {
  botId: string;
  threadId: string;
  sources: readonly CaptureSupervisorSource[];
  kind: CaptureKind;
  scheduledFor: number;
  trigger: CaptureSupervisorTrigger;
  strategy: CaptureSupervisorStrategy;
  /** The supervisor has already persisted the attempt before invoking this
   * callback. A callback may use this context to begin/finish CaptureLedger. */
  attemptId: string;
}

export type CaptureSupervisorExecute = (
  input: CaptureSupervisorExecuteInput,
) => CaptureSupervisorExecution | Promise<CaptureSupervisorExecution>;

export interface CaptureSupervisorSource {
  id: string;
  required: boolean;
}

export interface CaptureSupervisorOptions {
  botId: string;
  threadId: string;
  sources: readonly CaptureSupervisorSource[];
  ledger: CaptureLedger;
  execute: CaptureSupervisorExecute;
  file?: string;
  kind?: CaptureKind;
  now?: () => number;
  leaseMs?: number;
  quietReconcileMs?: number;
}

export type CaptureSupervisorTickResult =
  | { kind: "completed"; changed: true; retried: boolean; receipt: CaptureReceipt }
  | { kind: "skipped"; changed: false; reason: "No source marker changed" }
  | { kind: "failed"; changed: true; retried: boolean; error: string }
  | { kind: "busy"; changed: false }
  | { kind: "coalesced"; changed: false };

export interface CaptureSupervisorHealth {
  botId: string;
  state: "idle" | "healthy" | "degraded" | "interrupted";
  leaseHeld: boolean;
  pendingWakeups: number;
  lastMarker: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  interruptedAttempt: boolean;
  updatedAt: number;
}

const stateRowSchema = z.object({
  bot_id: z.string(),
  lease_owner: z.string().nullable(),
  lease_until: z.number(),
  pending_wake: z.number(),
  pending_trigger: z.enum(["push", "quiet", "startup", "manual"]),
  last_marker: z.string().nullable(),
  inflight_marker: z.string().nullable(),
  inflight_attempt_id: z.string().nullable(),
  inflight_started_at: z.number().nullable(),
  inflight_strategy: z.enum(["normal", "changed"]).nullable(),
  last_run_at: z.number().nullable(),
  last_error: z.string().nullable(),
  state: z.enum(["idle", "healthy", "degraded", "interrupted"]),
  updated_at: z.number(),
});

const EMPTY_ROUTINE: Omit<Routine, "botId" | "prefilter"> = {
  id: "capture-supervisor",
  name: "Capture supervisor",
  prompt: "",
  runOn: "maus",
  enabled: true,
  schedule: { type: "interval", everyMinutes: 5, from: "00:00", to: "23:59", weekdays: [0, 1, 2, 3, 4, 5, 6] },
  durationMinutes: 60,
  nextRunAt: null,
  createdAt: 0,
  updatedAt: 0,
};

const EMPTY_RUN: Omit<RoutineRun, "botId"> = {
  id: "capture-supervisor-run",
  routineId: EMPTY_ROUTINE.id,
  routineName: EMPTY_ROUTINE.name,
  runOn: "maus",
  scheduledFor: 0,
  status: "running",
  manual: false,
  createdAt: 0,
};

function cleanText(value: string, max: number): string {
  return value.trim().slice(0, max);
}

export class CaptureSupervisor {
  private readonly db: DatabaseSync;
  private readonly ownerId = randomUUID();
  private readonly botId: string;
  private readonly threadId: string;
  private readonly sources: CaptureSupervisorSource[];
  private readonly ledger: CaptureLedger;
  private readonly execute: CaptureSupervisorExecute;
  private readonly now: () => number;
  private readonly kind: CaptureKind;
  private readonly leaseMs: number;
  private readonly quietReconcileMs: number;
  private pumpPromise: Promise<CaptureSupervisorTickResult> | null = null;
  private quietTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CaptureSupervisorOptions) {
    this.botId = cleanText(options.botId, 120);
    this.threadId = cleanText(options.threadId, 120);
    if (!this.botId || !this.threadId) throw new Error("Capture supervisor needs a bot and thread");
    this.sources = [...new Map(options.sources.map((source) => [cleanText(source.id, 120), source.required])).entries()]
      .filter(([id]) => id.length > 0)
      .map(([id, required]) => ({ id, required }));
    if (this.sources.length === 0) throw new Error("Capture supervisor needs at least one source");
    this.ledger = options.ledger;
    this.execute = options.execute;
    this.now = options.now ?? Date.now;
    this.kind = options.kind ?? "fast";
    this.leaseMs = this.positive(options.leaseMs ?? 60_000, "Capture supervisor lease must be positive");
    this.quietReconcileMs = this.positive(options.quietReconcileMs ?? 5 * 60_000, "Capture quiet cadence must be positive");

    const file = options.file ?? join(DATA_DIR, "capture-supervisor.db");
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capture_supervisor_state (
        bot_id TEXT PRIMARY KEY,
        lease_owner TEXT,
        lease_until INTEGER NOT NULL,
        pending_wake INTEGER NOT NULL DEFAULT 0,
        pending_trigger TEXT NOT NULL DEFAULT 'quiet',
        last_marker TEXT,
        inflight_marker TEXT,
        inflight_attempt_id TEXT,
        inflight_started_at INTEGER,
        inflight_strategy TEXT,
        last_run_at INTEGER,
        last_error TEXT,
        state TEXT NOT NULL DEFAULT 'idle',
        updated_at INTEGER NOT NULL
      );
    `);
    this.initializeState();
  }

  /** Start quiet reconciliation. The timer only asks for a marker check; it
   * never starts a provider/model operation unless the marker changed. */
  start(): void {
    if (this.quietTimer !== null) return;
    this.quietTimer = setInterval(() => { void this.wake("quiet"); }, this.quietReconcileMs);
    this.quietTimer.unref?.();
    void this.wake("startup");
  }

  stop(): void {
    if (this.quietTimer !== null) clearInterval(this.quietTimer);
    this.quietTimer = null;
  }

  /** Push wakeups are durable and coalesced. A wake arriving during an active
   * capture sets one pending bit; it cannot launch a concurrent operation. */
  wake(trigger: CaptureSupervisorTrigger): Promise<CaptureSupervisorTickResult> {
    this.enqueue(trigger);
    if (this.pumpPromise !== null) return Promise.resolve({ kind: "coalesced", changed: false });
    this.pumpPromise = this.drain();
    return this.pumpPromise.finally(() => { this.pumpPromise = null; });
  }

  reconcileNow(): Promise<CaptureSupervisorTickResult> {
    return this.wake("quiet");
  }

  health(): CaptureSupervisorHealth {
    const row = this.stateRow();
    return {
      botId: row.bot_id,
      state: row.state,
      leaseHeld: row.lease_owner === this.ownerId && row.lease_until > this.now(),
      pendingWakeups: row.pending_wake,
      lastMarker: row.last_marker,
      lastRunAt: row.last_run_at,
      lastError: row.last_error,
      interruptedAttempt: row.state === "interrupted",
      updatedAt: row.updated_at,
    };
  }

  /** Source details remain owned by CaptureLedger; exposing this read-only
   * view beside supervisor health gives callers one operational seam without
   * copying cursors, captured content, or error payloads into supervisor DB. */
  sourceHealth(): CaptureSourceHealthSnapshot[] {
    return this.ledger.sourceHealth(this.botId, { now: this.now() });
  }

  close(): void {
    this.stop();
    this.releaseLease();
    this.db.close();
  }

  private async drain(): Promise<CaptureSupervisorTickResult> {
    let result: CaptureSupervisorTickResult = { kind: "busy", changed: false };
    let firstResult: CaptureSupervisorTickResult | null = null;
    try {
      while (true) {
        const row = this.stateRow();
        if (row.pending_wake === 0) break;
        if (!this.claimLease()) break;
        const trigger = row.pending_trigger;
        this.clearPending();
        result = await this.tick(trigger);
        firstResult ??= result;
      }
      return firstResult ?? result;
    } finally {
      this.releaseLease();
    }
  }

  private async tick(trigger: CaptureSupervisorTrigger): Promise<CaptureSupervisorTickResult> {
    const markerReader = async (_botId: string, sourceIds: readonly string[]) => this.ledger.sourceChangeMarkers(this.botId, sourceIds, { now: this.now() });
    const preflight = createChangeMarkerPreflight(markerReader);
    const routine: Routine = {
      ...EMPTY_ROUTINE,
      botId: this.botId,
      prefilter: { type: "change-marker", sourceIds: this.sources.map((source) => source.id) },
    };
    const run: RoutineRun = { ...EMPTY_RUN, botId: this.botId, scheduledFor: this.now() };
    const decision = await preflight(routine, run, this.stateRow().last_marker ?? undefined);
    if (decision.kind === "skip" || !decision.marker) {
      this.markTickHealthy();
      return { kind: "skipped", changed: false, reason: "No source marker changed" };
    }

    const attemptId = randomUUID();
    this.persistAttempt(decision.marker, attemptId, "normal");
    const heartbeat = setInterval(() => { this.extendLease(); }, Math.max(1, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();
    let retried = false;
    let outcome: CaptureSupervisorInvocation;
    try {
      const first = await this.invoke({ trigger, scheduledFor: this.now(), attemptId, strategy: "normal" });
      outcome = first;
      if (first.status === "retryable") {
        retried = true;
        const changedAttemptId = randomUUID();
        this.persistAttempt(decision.marker, changedAttemptId, "changed");
        outcome = await this.invoke({ trigger, scheduledFor: this.now(), attemptId: changedAttemptId, strategy: "changed" });
      }
    } finally {
      clearInterval(heartbeat);
    }

    if (outcome.status === "completed") {
      this.finishAttempt(decision.marker, outcome.receipt);
      return { kind: "completed", changed: true, retried, receipt: outcome.receipt };
    }
    const error = outcome.status === "retryable"
      ? cleanText(outcome.reason, 2_000) || "Capture retry failed"
      : outcome.error;
    this.failAttempt(decision.marker, error);
    return { kind: "failed", changed: true, retried, error };
  }

  private async invoke(input: Omit<CaptureSupervisorExecuteInput, "botId" | "threadId" | "sources" | "kind">): Promise<CaptureSupervisorInvocation> {
    try {
      return await this.execute({ ...input, botId: this.botId, threadId: this.threadId, sources: this.sources, kind: this.kind });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Capture execution failed";
      return { status: "failed", error: cleanText(detail, 2_000) || "Capture execution failed" };
    }
  }

  private initializeState(): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO capture_supervisor_state (bot_id, lease_until, pending_trigger, updated_at)
        VALUES (?, 0, 'quiet', ?)
        ON CONFLICT(bot_id) DO NOTHING
      `).run(this.botId, this.now());
      const row = this.stateRow();
      if (row.inflight_attempt_id === null || row.lease_until > this.now()) return;
      // Persist the marker that was already claimed before the process died.
      // This makes restart idempotent: unchanged input is suppressed, while a
      // genuinely new source marker remains eligible for a fresh attempt.
      this.db.prepare(`
        UPDATE capture_supervisor_state
        SET lease_owner = NULL, lease_until = 0, inflight_attempt_id = NULL,
            inflight_started_at = NULL, inflight_strategy = NULL,
            last_marker = COALESCE(inflight_marker, last_marker), inflight_marker = NULL,
            state = 'interrupted', last_error = 'Capture supervisor restarted during an attempt', updated_at = ?
        WHERE bot_id = ?
      `).run(this.now(), this.botId);
    });
  }

  private enqueue(trigger: CaptureSupervisorTrigger): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE capture_supervisor_state SET pending_wake = 1, pending_trigger = ?, updated_at = ? WHERE bot_id = ?`).run(trigger, this.now(), this.botId);
    });
  }

  private clearPending(): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE capture_supervisor_state SET pending_wake = 0, updated_at = ? WHERE bot_id = ?`).run(this.now(), this.botId);
    });
  }

  private markTickHealthy(): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE capture_supervisor_state SET state = CASE WHEN state = 'interrupted' THEN 'interrupted' ELSE 'healthy' END, last_error = NULL, updated_at = ? WHERE bot_id = ?`).run(this.now(), this.botId);
    });
  }

  private persistAttempt(marker: string, attemptId: string, strategy: CaptureSupervisorStrategy): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE capture_supervisor_state SET inflight_marker = ?, inflight_attempt_id = ?,
          inflight_started_at = ?, inflight_strategy = ?, state = 'idle', last_error = NULL, updated_at = ?
        WHERE bot_id = ?
      `).run(marker, attemptId, this.now(), strategy, this.now(), this.botId);
    });
  }

  private finishAttempt(marker: string, receipt: CaptureReceipt): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE capture_supervisor_state SET last_marker = ?, inflight_marker = NULL,
          inflight_attempt_id = NULL, inflight_started_at = NULL, inflight_strategy = NULL,
          last_run_at = ?, last_error = NULL, state = ?, updated_at = ? WHERE bot_id = ?
      `).run(marker, receipt.report.scheduledFor, receipt.report.status === "degraded" ? "degraded" : "healthy", this.now(), this.botId);
    });
  }

  private failAttempt(marker: string, error: string): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE capture_supervisor_state SET last_marker = ?, inflight_marker = NULL,
          inflight_attempt_id = NULL, inflight_started_at = NULL, inflight_strategy = NULL,
          last_run_at = ?, last_error = ?, state = 'degraded', updated_at = ? WHERE bot_id = ?
      `).run(marker, this.now(), error, this.now(), this.botId);
    });
  }

  private claimLease(): boolean {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE capture_supervisor_state SET lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE bot_id = ? AND (lease_until <= ? OR lease_owner = ?)
    `).run(this.ownerId, now + this.leaseMs, now, this.botId, now, this.ownerId);
    return result.changes === 1;
  }

  private extendLease(): void {
    try {
      const now = this.now();
      this.db.prepare(`
        UPDATE capture_supervisor_state SET lease_until = ?, updated_at = ?
        WHERE bot_id = ? AND lease_owner = ?
      `).run(now + this.leaseMs, now, this.botId, this.ownerId);
    } catch {
      // A closing/restarting process will release or abandon the lease. The
      // active callback must not be interrupted by a best-effort heartbeat.
    }
  }

  private releaseLease(): void {
    try {
      this.db.prepare(`UPDATE capture_supervisor_state SET lease_owner = NULL, lease_until = 0, updated_at = ? WHERE bot_id = ? AND lease_owner = ?`).run(this.now(), this.botId, this.ownerId);
    } catch {
      // Close/restart races must not hide the original capture outcome.
    }
  }

  private stateRow() {
    return stateRowSchema.parse(this.db.prepare(`SELECT * FROM capture_supervisor_state WHERE bot_id = ?`).get(this.botId));
  }

  private positive(value: number, message: string): number {
    if (!Number.isFinite(value) || value <= 0) throw new Error(message);
    return value;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }
}
