import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import { captureSourceFreshnessPolicy } from "./capture-source-cadence.ts";
import { parseJson, type JsonValue } from "./schema.ts";

const captureActionClassSchema = z.enum([
  "Build",
  "Money chase",
  "Collect then deliver",
  "Outbound follow-up",
  "Redline/legal",
  "Calendar/RSVP",
  "File a loop",
  "Ignore",
]);

export const CAPTURE_ACTION_CLASSES = captureActionClassSchema.options;
export type CaptureActionClass = z.infer<typeof captureActionClassSchema>;
export type CaptureKind = "fast" | "hourly" | "manual";
export type CaptureSourceStatus = "ok" | "empty" | "failed" | "needs-auth";

export interface CaptureAction {
  class: CaptureActionClass;
  source: string;
  summary: string;
  ask?: string;
  proposedMove?: string;
  evidenceRef?: string;
}

export interface CaptureBeginInput {
  botId: string;
  threadId: string;
  kind: CaptureKind;
  scheduledFor: number;
  sources: Array<{ id: string; required: boolean }>;
}

export interface CaptureSourceCursor {
  sourceId: string;
  cursor: JsonValue;
  lastSuccessAt: number | null;
}

export interface CaptureRunStart {
  runId: string;
  cursors: CaptureSourceCursor[];
  pendingOutbox: CaptureOutboxEntry[];
}

interface CaptureSourceOk {
  status: "ok";
  cursor: JsonValue;
  itemCount: number;
  actions?: CaptureAction[];
}

interface CaptureSourceEmpty {
  status: "empty";
  cursor: JsonValue;
  itemCount: number;
  actions?: CaptureAction[];
}

interface CaptureSourceFailed {
  status: "failed";
  error: string;
}

interface CaptureSourceNeedsAuth {
  status: "needs-auth";
  error: string;
}

export type CaptureSourceRecordInput =
  | CaptureSourceOk
  | CaptureSourceEmpty
  | CaptureSourceFailed
  | CaptureSourceNeedsAuth;

export interface CaptureSourceReceipt {
  sourceId: string;
  required: boolean;
  status: CaptureSourceStatus;
  itemCount: number;
  error?: string;
}

export interface CaptureReport {
  runId: string;
  kind: CaptureKind;
  scheduledFor: number;
  status: "completed" | "degraded";
  sourceHealth: CaptureSourceReceipt[];
  actionItems: CaptureAction[];
}

export interface CaptureOutboxEntry {
  id: string;
  botId: string;
  runId: string;
  report: CaptureReport;
  createdAt: number;
}

export interface CaptureReceipt {
  report: CaptureReport;
  outbox: CaptureOutboxEntry | null;
}

export interface CaptureSourceHealthSnapshot {
  botId: string;
  sourceId: string;
  status: CaptureSourceStatus;
  /** Freshness is independent from the last attempt status: a recent failed
   * attempt is still an error, while the last successful receipt may remain
   * fresh enough for diagnosis. */
  freshness: "fresh" | "stale" | "unknown";
  lastSuccessAt: number | null;
  lastAttemptAt: number;
  lastError: string | null;
}

export interface CaptureSourceChangeMarker {
  sourceId: string;
  marker: string | null;
  status: CaptureSourceStatus | "unknown";
  freshness: "fresh" | "stale" | "unknown";
  /** True when the source can be compared deterministically. Healthy sources
   * compare their cursor. Unavailable sources compare a redacted failure
   * fingerprint plus a bounded retry bucket so they retry periodically
   * instead of invoking a model every five minutes forever. */
  ready: boolean;
}

export const CAPTURE_UNAVAILABLE_PREFILTER_RETRY_MS = 30 * 60_000;

export interface CaptureRunSummary {
  status: string;
  count: number;
  latestAt: number | null;
}

export interface CaptureStatusSnapshot {
  botId: string;
  state: "never-run" | "running" | "healthy" | "degraded";
  latestRun: {
    id: string;
    kind: CaptureKind;
    scheduledFor: number;
    status: "running" | "completed" | "degraded";
    startedAt: number;
    finishedAt: number | null;
  } | null;
  lastSuccessfulRunAt: number | null;
  pendingOutboxCount: number;
  sourceHealth: Array<{
    sourceId: string;
    status: CaptureSourceStatus;
    freshness: "fresh" | "stale" | "unknown";
    lastSuccessAt: number | null;
    lastAttemptAt: number;
  }>;
}

const runRowSchema = z.object({
  id: z.string(),
  bot_id: z.string(),
  kind: z.enum(["fast", "hourly", "manual"]),
  scheduled_for: z.number(),
  status: z.string(),
});

const expectedSourceRowSchema = z.object({
  source_id: z.string(),
  required: z.number(),
  status: z.string().nullable(),
  item_count: z.number().nullable(),
  error: z.string().nullable(),
  actions_json: z.string().nullable(),
});

const cursorRowSchema = z.object({
  source_id: z.string(),
  cursor_json: z.string(),
  last_success_at: z.number().nullable(),
});

const outboxRowSchema = z.object({
  id: z.string(),
  bot_id: z.string(),
  run_id: z.string(),
  report_json: z.string(),
  created_at: z.number(),
});

const sourceHealthRowSchema = z.object({
  bot_id: z.string(),
  source_id: z.string(),
  health: z.enum(["ok", "empty", "failed", "needs-auth"]),
  last_success_at: z.number().nullable(),
  last_attempt_at: z.number(),
  last_error: z.string().nullable(),
});

const runSummaryRowSchema = z.object({
  status: z.string(),
  count: z.number(),
  latest_at: z.number().nullable(),
});

const latestRunRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["fast", "hourly", "manual"]),
  scheduled_for: z.number(),
  status: z.enum(["running", "completed", "degraded"]),
  started_at: z.number(),
  finished_at: z.number().nullable(),
});

const lastSuccessfulRunRowSchema = z.object({
  finished_at: z.number().nullable(),
});

const staleRunRowSchema = z.object({
  id: z.string(),
  bot_id: z.string(),
});

const captureActionSchema = z.object({
  class: captureActionClassSchema,
  source: z.string(),
  summary: z.string(),
  ask: z.string().optional(),
  proposedMove: z.string().optional(),
  evidenceRef: z.string().optional(),
});

const captureReportSchema = z.object({
  runId: z.string(),
  kind: z.enum(["fast", "hourly", "manual"]),
  scheduledFor: z.number(),
  status: z.enum(["completed", "degraded"]),
  sourceHealth: z.array(z.object({
    sourceId: z.string(),
    required: z.boolean(),
    status: z.enum(["ok", "empty", "failed", "needs-auth"]),
    itemCount: z.number(),
    error: z.string().optional(),
  })),
  actionItems: z.array(captureActionSchema),
});

function limitedText(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function serializeCursor(cursor: JsonValue): string {
  const serialized = JSON.stringify(cursor ?? null);
  if (serialized.length > 64_000) throw new Error("Capture cursor is too large");
  return serialized;
}

function normalizeActions(actions: CaptureAction[] | undefined, sourceId: string): CaptureAction[] {
  return (actions ?? []).slice(0, 100).map((action) => {
    const normalized: CaptureAction = {
      class: action.class,
      source: limitedText(action.source || sourceId, 120),
      summary: limitedText(action.summary, 2_000),
    };
    if (action.ask) normalized.ask = limitedText(action.ask, 1_000);
    if (action.proposedMove) normalized.proposedMove = limitedText(action.proposedMove, 1_000);
    if (action.evidenceRef) normalized.evidenceRef = limitedText(action.evidenceRef, 500);
    return normalized;
  });
}

export class CaptureLedger {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(options: { file?: string; now?: () => number } = {}) {
    const file = options.file ?? join(DATA_DIR, "capture.db");
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.now = options.now ?? Date.now;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capture_runs (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS capture_expected_sources (
        run_id TEXT NOT NULL REFERENCES capture_runs(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        required INTEGER NOT NULL,
        status TEXT,
        item_count INTEGER,
        error TEXT,
        actions_json TEXT,
        recorded_at INTEGER,
        PRIMARY KEY (run_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS capture_source_state (
        bot_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        cursor_json TEXT NOT NULL,
        last_success_at INTEGER,
        last_attempt_at INTEGER NOT NULL,
        health TEXT NOT NULL,
        last_error TEXT,
        PRIMARY KEY (bot_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS capture_outbox (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE REFERENCES capture_runs(id) ON DELETE CASCADE,
        report_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER
      );
    `);
  }

  begin(input: CaptureBeginInput): CaptureRunStart {
    const botId = limitedText(input.botId, 120);
    const threadId = limitedText(input.threadId, 120);
    const sources = [...new Map(input.sources.map((source) => [limitedText(source.id, 120), source.required])).entries()]
      .filter(([sourceId]) => sourceId.length > 0)
      .map(([id, required]) => ({ id, required }));
    if (!botId || !threadId) throw new Error("Capture run needs a bot and thread");
    if (!Number.isFinite(input.scheduledFor)) throw new Error("Capture run needs a valid scheduled time");
    if (sources.length === 0) throw new Error("Capture run needs at least one source");

    const runId = randomUUID();
    const now = this.now();
    this.transaction(() => {
      const active = this.db.prepare(`
        SELECT id FROM capture_runs WHERE bot_id = ? AND status = 'running' LIMIT 1
      `).get(botId);
      if (active) throw new Error("Capture already has an active run for this bot");
      this.db.prepare(`
        INSERT INTO capture_runs (id, bot_id, thread_id, kind, scheduled_for, status, started_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?)
      `).run(runId, botId, threadId, input.kind, input.scheduledFor, now);
      const insertSource = this.db.prepare(`
        INSERT INTO capture_expected_sources (run_id, source_id, required) VALUES (?, ?, ?)
      `);
      for (const source of sources) insertSource.run(runId, source.id, source.required ? 1 : 0);
    });

    const stateRows = this.db.prepare(`
      SELECT source_id, cursor_json, last_success_at
      FROM capture_source_state WHERE bot_id = ?
    `).all(botId);
    const state = new Map<string, z.infer<typeof cursorRowSchema>>();
    for (const row of stateRows) {
      const parsed = cursorRowSchema.parse(row);
      state.set(parsed.source_id, parsed);
    }
    return {
      runId,
      cursors: sources.map((source) => {
        const previous = state.get(source.id);
        return {
          sourceId: source.id,
          cursor: previous ? parseJson(previous.cursor_json) : null,
          lastSuccessAt: previous?.last_success_at ?? null,
        };
      }),
      pendingOutbox: this.pendingOutbox(botId),
    };
  }

  recordSource(botId: string, runId: string, sourceId: string, input: CaptureSourceRecordInput): void {
    const run = this.run(runId);
    if (run.bot_id !== botId) throw new Error("Capture run belongs to another bot");
    if (run.status !== "running") throw new Error("Capture run is already finished");
    const expected = this.db.prepare(`
      SELECT source_id FROM capture_expected_sources WHERE run_id = ? AND source_id = ?
    `).get(runId, sourceId);
    if (!expected) throw new Error(`Source ${sourceId} is not part of this capture run`);
    const now = this.now();
    if (input.status === "ok" || input.status === "empty") {
      const itemCount = Math.max(0, Math.round(input.itemCount));
      const actions = normalizeActions(input.actions, sourceId);
      const cursorJson = serializeCursor(input.cursor);
      this.transaction(() => {
        this.db.prepare(`
          UPDATE capture_expected_sources
          SET status = ?, item_count = ?, error = NULL, actions_json = ?, recorded_at = ?
          WHERE run_id = ? AND source_id = ?
        `).run(input.status, itemCount, JSON.stringify(actions), now, runId, sourceId);
        this.db.prepare(`
          INSERT INTO capture_source_state
            (bot_id, source_id, cursor_json, last_success_at, last_attempt_at, health, last_error)
          VALUES (?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(bot_id, source_id) DO UPDATE SET
            cursor_json = excluded.cursor_json,
            last_success_at = excluded.last_success_at,
            last_attempt_at = excluded.last_attempt_at,
            health = excluded.health,
            last_error = NULL
        `).run(run.bot_id, sourceId, cursorJson, now, now, input.status);
      });
      return;
    }

    const error = limitedText(input.error, 2_000) || (input.status === "needs-auth" ? "Authentication required" : "Source failed");
    this.transaction(() => {
      this.db.prepare(`
        UPDATE capture_expected_sources
        SET status = ?, item_count = 0, error = ?, actions_json = '[]', recorded_at = ?
        WHERE run_id = ? AND source_id = ?
      `).run(input.status, error, now, runId, sourceId);
      this.db.prepare(`
        INSERT INTO capture_source_state
          (bot_id, source_id, cursor_json, last_success_at, last_attempt_at, health, last_error)
        VALUES (?, ?, 'null', NULL, ?, ?, ?)
        ON CONFLICT(bot_id, source_id) DO UPDATE SET
          last_attempt_at = excluded.last_attempt_at,
          health = excluded.health,
          last_error = excluded.last_error
      `).run(run.bot_id, sourceId, now, input.status, error);
    });
  }

  finish(botId: string, runId: string, options: { forceDegraded?: boolean } = {}): CaptureReceipt {
    const run = this.run(runId);
    if (run.bot_id !== botId) throw new Error("Capture run belongs to another bot");
    if (run.status !== "running") throw new Error("Capture run is already finished");
    const rows = this.sourceRows(runId);
    const now = this.now();
    for (const row of rows) {
      if (row.status !== null) continue;
      const error = "Capture source did not record a result";
      this.db.prepare(`
        UPDATE capture_expected_sources
        SET status = 'failed', item_count = 0, error = ?, actions_json = '[]', recorded_at = ?
        WHERE run_id = ? AND source_id = ?
      `).run(error, now, runId, row.source_id);
    }
    const report = this.reportForRun(run, options.forceDegraded === true);
    let outbox: CaptureOutboxEntry | null = null;
    this.transaction(() => {
      this.db.prepare(`
        UPDATE capture_runs SET status = ?, finished_at = ? WHERE id = ?
      `).run(report.status, now, runId);
      if (report.status === "degraded" || report.actionItems.length > 0) {
        const id = randomUUID();
        this.db.prepare(`
          INSERT INTO capture_outbox (id, bot_id, run_id, report_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, run.bot_id, runId, JSON.stringify(report), now);
        outbox = { id, botId: run.bot_id, runId, report, createdAt: now };
      }
    });
    return { report, outbox };
  }

  /** Read the authoritative receipt after a provider turn has called
   * capture_finish. Resident supervisors use this instead of manufacturing a
   * success receipt from the provider's final text. */
  receiptForRun(botId: string, runId: string): CaptureReceipt | null {
    const run = this.run(runId);
    if (run.bot_id !== botId) throw new Error("Capture run belongs to another bot");
    if (run.status === "running") return null;
    const report = this.reportForRun(run, run.status === "degraded");
    const outboxRow = this.db.prepare(`
      SELECT id, bot_id, run_id, report_json, created_at
      FROM capture_outbox WHERE bot_id = ? AND run_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(botId, runId);
    const outbox = outboxRow
      ? (() => {
        const parsed = outboxRowSchema.parse(outboxRow);
        return {
          id: parsed.id,
          botId: parsed.bot_id,
          runId: parsed.run_id,
          report: captureReportSchema.parse(parseJson(parsed.report_json)),
          createdAt: parsed.created_at,
        } satisfies CaptureOutboxEntry;
      })()
      : null;
    return { report, outbox };
  }

  pendingOutbox(botId: string): CaptureOutboxEntry[] {
    return this.db.prepare(`
      SELECT id, bot_id, run_id, report_json, created_at
      FROM capture_outbox
      WHERE bot_id = ? AND acknowledged_at IS NULL
      ORDER BY created_at ASC
      LIMIT 50
    `).all(botId).map((row) => {
      const parsed = outboxRowSchema.parse(row);
      return {
        id: parsed.id,
        botId: parsed.bot_id,
        runId: parsed.run_id,
        report: captureReportSchema.parse(parseJson(parsed.report_json)),
        createdAt: parsed.created_at,
      };
    });
  }

  acknowledgeOutbox(botId: string, outboxId: string): boolean {
    const result = this.db.prepare(`
      UPDATE capture_outbox SET acknowledged_at = ?
      WHERE id = ? AND bot_id = ? AND acknowledged_at IS NULL
    `).run(this.now(), outboxId, botId);
    return result.changes === 1;
  }

  /** One read-only operational view for coordinators and source operators.
   * It deliberately excludes provider cursors, captured content, actions,
   * outbox reports, and raw error text. Reading it never starts a run. */
  status(botId: string): CaptureStatusSnapshot {
    const cleanBotId = limitedText(botId, 120);
    if (!cleanBotId) throw new Error("Capture status needs a bot");
    const latestRow = this.db.prepare(`
      SELECT id, kind, scheduled_for, status, started_at, finished_at
      FROM capture_runs WHERE bot_id = ?
      ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get(cleanBotId);
    const latest = latestRow ? latestRunRowSchema.parse(latestRow) : null;
    const successRow = lastSuccessfulRunRowSchema.parse(this.db.prepare(`
      SELECT MAX(finished_at) AS finished_at
      FROM capture_runs WHERE bot_id = ? AND status = 'completed'
    `).get(cleanBotId));
    const sourceHealth = this.sourceHealth(cleanBotId).map((source) => ({
      sourceId: source.sourceId,
      status: source.status,
      freshness: source.freshness,
      lastSuccessAt: source.lastSuccessAt,
      lastAttemptAt: source.lastAttemptAt,
    }));
    const degraded = latest?.status === "degraded" || sourceHealth.some(
      (source) => source.status === "failed"
        || source.status === "needs-auth"
        || source.freshness !== "fresh",
    );
    return {
      botId: cleanBotId,
      state: latest === null
        ? "never-run"
        : latest.status === "running"
          ? "running"
          : degraded
            ? "degraded"
            : "healthy",
      latestRun: latest === null ? null : {
        id: latest.id,
        kind: latest.kind,
        scheduledFor: latest.scheduled_for,
        status: latest.status,
        startedAt: latest.started_at,
        finishedAt: latest.finished_at,
      },
      lastSuccessfulRunAt: successRow.finished_at,
      pendingOutboxCount: this.pendingOutbox(cleanBotId).length,
      sourceHealth,
    };
  }

  sourceHealth(botId?: string, options: { now?: number; staleAfterMs?: number } = {}): CaptureSourceHealthSnapshot[] {
    const now = options.now ?? this.now();
    const requestedStaleAfterMs = options.staleAfterMs;
    const rows = botId
      ? this.db.prepare(`
          SELECT bot_id, source_id, health, last_success_at, last_attempt_at, last_error
          FROM capture_source_state WHERE bot_id = ? ORDER BY source_id ASC
        `).all(botId)
      : this.db.prepare(`
          SELECT bot_id, source_id, health, last_success_at, last_attempt_at, last_error
          FROM capture_source_state ORDER BY bot_id ASC, source_id ASC
        `).all();
    return rows.map((row) => {
      const parsed = sourceHealthRowSchema.parse(row);
      const policy = captureSourceFreshnessPolicy(parsed.source_id);
      const staleAfterMs = requestedStaleAfterMs !== undefined && Number.isFinite(requestedStaleAfterMs) && requestedStaleAfterMs > 0
        ? requestedStaleAfterMs
        : policy.expectedMaxAgeMs;
      return {
        botId: parsed.bot_id,
        sourceId: parsed.source_id,
        status: parsed.health,
        freshness: parsed.last_success_at === null
          ? "unknown"
          : now - parsed.last_success_at <= staleAfterMs && now >= parsed.last_success_at
            ? "fresh"
            : "stale",
        lastSuccessAt: parsed.last_success_at,
        lastAttemptAt: parsed.last_attempt_at,
        lastError: parsed.last_error,
      };
    });
  }

  /** Return opaque, deterministic markers for routine prefilters without
   * exposing cursors or errors to the UI or model. Healthy sources change
   * immediately with their cursor. Missing, stale, failed, and auth-blocked
   * sources change once per retry bucket, preventing retry storms while still
   * probing recovery on a bounded cadence. */
  sourceChangeMarkers(
    botId: string,
    sourceIds: readonly string[],
    options: { now?: number } = {},
  ): CaptureSourceChangeMarker[] {
    const now = options.now ?? this.now();
    const rows = this.db.prepare(`
      SELECT source_id, cursor_json, health, last_success_at, last_error
      FROM capture_source_state WHERE bot_id = ?
    `).all(botId);
    const state = new Map<string, {
      cursorJson: string;
      status: CaptureSourceStatus;
      lastSuccessAt: number | null;
      lastError: string | null;
    }>();
    for (const row of rows) {
      const sourceId = typeof row.source_id === "string" ? row.source_id : "";
      const cursorJson = typeof row.cursor_json === "string" ? row.cursor_json : "null";
      const status = z.enum(["ok", "empty", "failed", "needs-auth"]).safeParse(row.health);
      if (!sourceId || !status.success) continue;
      state.set(sourceId, {
        cursorJson,
        status: status.data,
        lastSuccessAt: typeof row.last_success_at === "number" ? row.last_success_at : null,
        lastError: typeof row.last_error === "string" ? row.last_error : null,
      });
    }
    const unavailableRetryBucket = Math.floor(now / CAPTURE_UNAVAILABLE_PREFILTER_RETRY_MS);
    return [...new Set(sourceIds.map((sourceId) => sourceId.trim()).filter(Boolean))].map((sourceId) => {
      const current = state.get(sourceId);
      if (!current) {
        return {
          sourceId,
          marker: createHash("sha256").update(`unknown:${sourceId}:${unavailableRetryBucket}`).digest("hex"),
          status: "unknown" as const,
          freshness: "unknown" as const,
          ready: true,
        };
      }
      const policy = captureSourceFreshnessPolicy(sourceId);
      const freshness: CaptureSourceChangeMarker["freshness"] = current.lastSuccessAt === null
        ? "unknown"
        : now - current.lastSuccessAt <= policy.expectedMaxAgeMs && now >= current.lastSuccessAt
          ? "fresh"
          : "stale";
      const hasCursor = current.cursorJson !== "null";
      const healthy = (current.status === "ok" || current.status === "empty") && freshness === "fresh" && hasCursor;
      const markerMaterial = healthy
        ? `cursor:${current.cursorJson}`
        : `unavailable:${current.status}:${freshness}:${current.cursorJson}:${current.lastError ?? ""}:${unavailableRetryBucket}`;
      return {
        sourceId,
        marker: createHash("sha256").update(markerMaterial).digest("hex"),
        status: current.status,
        freshness,
        ready: true,
      };
    });
  }

  runSummary(since: number): CaptureRunSummary[] {
    return this.db.prepare(`
      SELECT status, COUNT(*) AS count, MAX(started_at) AS latest_at
      FROM capture_runs WHERE started_at >= ? GROUP BY status ORDER BY status ASC
    `).all(since).map((row) => {
      const parsed = runSummaryRowSchema.parse(row);
      return { status: parsed.status, count: parsed.count, latestAt: parsed.latest_at };
    });
  }

  /** Fail closed and publish a durable degraded report for capture runs whose
   * worker disappeared. This preserves every committed cursor and makes the
   * interruption visible instead of leaving a permanent `running` row. */
  recoverStaleRuns(maxAgeMs = 60 * 60_000): CaptureReceipt[] {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("Capture stale timeout must be positive");
    const now = this.now();
    const stale = this.db.prepare(`
      SELECT id, bot_id FROM capture_runs
      WHERE status = 'running' AND started_at <= ?
      ORDER BY started_at ASC
    `).all(now - maxAgeMs).map((row) => staleRunRowSchema.parse(row));

    return this.recoverRuns(stale, "Capture run exceeded its recovery timeout");
  }

  /** No provider or scheduled task survives a full app restart. Reconcile all
   * rows immediately instead of waiting an hour while new Capture work piles
   * up behind a worker that no longer exists. */
  recoverRunningRunsAfterRestart(): CaptureReceipt[] {
    const running = this.db.prepare(`
      SELECT id, bot_id FROM capture_runs
      WHERE status = 'running'
      ORDER BY started_at ASC
    `).all().map((row) => staleRunRowSchema.parse(row));
    return this.recoverRuns(running, "OpenMausBot restarted before Capture finished");
  }

  /** Settle a Capture lifecycle whose owning scheduled turn has ended or was
   * cancelled without calling capture_finish. Correctly finished rows are
   * already terminal and therefore untouched. */
  recoverRunsForThread(threadId: string, reason = "Capture worker ended before capture_finish"): CaptureReceipt[] {
    const cleanThreadId = limitedText(threadId, 120);
    if (!cleanThreadId) return [];
    const running = this.db.prepare(`
      SELECT id, bot_id FROM capture_runs
      WHERE status = 'running' AND thread_id = ?
      ORDER BY started_at ASC
    `).all(cleanThreadId).map((row) => staleRunRowSchema.parse(row));
    return this.recoverRuns(running, limitedText(reason, 500) || "Capture worker ended before capture_finish");
  }

  private recoverRuns(stale: Array<z.infer<typeof staleRunRowSchema>>, recoveryError: string): CaptureReceipt[] {
    const now = this.now();
    const recovered: CaptureReceipt[] = [];
    for (const run of stale) {
      this.transaction(() => {
        // Re-read inside the write transaction. A worker can finish a source
        // between the stale-run scan and this recovery pass; using the older
        // snapshot would incorrectly overwrite that successful source state
        // with a failure.
        const missing = this.sourceRows(run.id).filter((source) => source.status === null);
        const error = recoveryError;
        const failExpected = this.db.prepare(`
          UPDATE capture_expected_sources
          SET status = 'failed', item_count = 0, error = ?, actions_json = '[]', recorded_at = ?
          WHERE run_id = ? AND source_id = ? AND status IS NULL
        `);
        const failState = this.db.prepare(`
          INSERT INTO capture_source_state
            (bot_id, source_id, cursor_json, last_success_at, last_attempt_at, health, last_error)
          VALUES (?, ?, 'null', NULL, ?, 'failed', ?)
          ON CONFLICT(bot_id, source_id) DO UPDATE SET
            last_attempt_at = excluded.last_attempt_at,
            health = excluded.health,
            last_error = excluded.last_error
        `);
        for (const source of missing) {
          failExpected.run(error, now, run.id, source.source_id);
          failState.run(run.bot_id, source.source_id, now, error);
        }
      });
      // A worker disappearing after recording all source results is still an
      // interrupted run.  Force the durable report to degraded so it cannot
      // masquerade as a verified completion or silently drop its outbox.
      try {
        recovered.push(this.finish(run.bot_id, run.id, { forceDegraded: true }));
      } catch (error) {
        // The worker may have finished just after the stale-run query but
        // before recovery acquired its write transaction. Its own receipt is
        // authoritative; do not let that benign race crash the recovery timer.
        if (!(error instanceof Error) || !/already finished/i.test(error.message)) throw error;
      }
    }
    return recovered;
  }

  close(): void {
    this.db.close();
  }

  private run(runId: string) {
    return runRowSchema.parse(this.db.prepare(`
      SELECT id, bot_id, kind, scheduled_for, status FROM capture_runs WHERE id = ?
    `).get(runId));
  }

  private reportForRun(run: { id: string; kind: CaptureKind; scheduled_for: number; status: string }, forceDegraded: boolean): CaptureReport {
    const completedRows = this.sourceRows(run.id);
    const sourceHealth = completedRows.map((row): CaptureSourceReceipt => {
      const receipt: CaptureSourceReceipt = {
        sourceId: row.source_id,
        required: row.required === 1,
        status: z.enum(["ok", "empty", "failed", "needs-auth"]).parse(row.status),
        itemCount: row.item_count ?? 0,
      };
      if (row.error) receipt.error = row.error;
      return receipt;
    });
    const actionItems = completedRows.flatMap((row) => {
      if (!row.actions_json) return [];
      return z.array(captureActionSchema).parse(parseJson(row.actions_json));
    }).filter((action) => action.class !== "Ignore");
    const degraded = forceDegraded || sourceHealth.some(
      (source) => source.status === "failed" || source.status === "needs-auth",
    );
    return {
      runId: run.id,
      kind: run.kind,
      scheduledFor: run.scheduled_for,
      status: degraded ? "degraded" : "completed",
      sourceHealth,
      actionItems,
    };
  }

  private sourceRows(runId: string) {
    return this.db.prepare(`
      SELECT source_id, required, status, item_count, error, actions_json
      FROM capture_expected_sources WHERE run_id = ? ORDER BY source_id ASC
    `).all(runId).map((row) => expectedSourceRowSchema.parse(row));
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
