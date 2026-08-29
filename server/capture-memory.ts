import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import { parseJson, type JsonValue } from "./schema.ts";

export const CAPTURE_MEMORY_SENSITIVITIES = ["public", "internal", "sensitive", "restricted"] as const;
export type CaptureMemorySensitivity = (typeof CAPTURE_MEMORY_SENSITIVITIES)[number];

export const CAPTURE_MEMORY_STATES = ["active", "tombstone"] as const;
export type CaptureMemoryState = (typeof CAPTURE_MEMORY_STATES)[number];

const sensitivitySchema = z.enum(CAPTURE_MEMORY_SENSITIVITIES);
const stateSchema = z.enum(CAPTURE_MEMORY_STATES);

const nonEmptyId = (max: number) => z.string().trim().min(1).max(max);

export const captureMemoryItemInputSchema = z.object({
  botId: nonEmptyId(120),
  sectionId: z.string().trim().max(120).optional(),
  sourceId: nonEmptyId(120),
  accountId: z.string().trim().max(240).optional(),
  eventId: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,240}$/).optional(),
  externalId: z.string().trim().max(500).optional(),
  kind: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(400),
  body: z.string().max(100_000).optional(),
  occurredAt: z.number().finite(),
  capturedAt: z.number().finite().optional(),
  sensitivity: sensitivitySchema,
  evidenceRef: z.string().trim().max(2_000).optional(),
  payloadRef: z.string().trim().max(2_000).optional(),
  metadata: z.json().optional(),
});
export type CaptureMemoryItemInput = z.input<typeof captureMemoryItemInputSchema>;

export interface CaptureMemoryItem {
  eventId: string;
  botId: string;
  sectionId: string | null;
  sourceId: string;
  accountId: string | null;
  kind: string;
  title: string;
  body: string | null;
  occurredAt: number;
  capturedAt: number;
  sensitivity: CaptureMemorySensitivity;
  state: CaptureMemoryState;
  contentHash: string;
  identityKey: string;
  evidenceRef: string | null;
  payloadRef: string | null;
  metadata: JsonValue | null;
  supersedesEventId: string | null;
  updatedAt: number;
}

export interface CaptureMemoryUpserted {
  status: "inserted" | "updated" | "deduplicated" | "ignored-tombstone";
  item: CaptureMemoryItem;
}

export interface CaptureMemoryCorrection {
  targetEventId: string;
  replacementEventId: string;
  reason: string;
  recordedAt: number;
}

export interface CaptureMemorySearchOptions {
  query?: string;
  botId?: string;
  sectionId?: string;
  sourceId?: string;
  sourceIds?: readonly string[];
  accountId?: string;
  /** Exact normalized item kind, useful for narrowly scoped source readers. */
  kind?: string;
  /** Prefix match for namespaced source accounts (for example phone:). */
  accountPrefix?: string;
  since?: number;
  until?: number;
  includeSensitive?: boolean;
  limit?: number;
}

export interface CaptureMemorySearchResult {
  item: CaptureMemoryItem;
  provenance: {
    sourceId: string;
    accountId: string | null;
    occurredAt: number;
    capturedAt: number;
    sensitivity: CaptureMemorySensitivity;
    evidenceRef: string | null;
    payloadRef: string | null;
  };
}

export interface CaptureMemoryTombstone {
  targetEventId: string;
  replacementEventId: string | null;
  reason: string;
  recordedAt: number;
}

const itemRowSchema = z.object({
  event_id: z.string(),
  bot_id: z.string(),
  section_id: z.string().nullable(),
  source_id: z.string(),
  account_id: z.string().nullable(),
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  occurred_at: z.number(),
  captured_at: z.number(),
  sensitivity: z.string(),
  state: z.string(),
  content_hash: z.string(),
  identity_key: z.string(),
  evidence_ref: z.string().nullable(),
  payload_ref: z.string().nullable(),
  metadata_json: z.string().nullable(),
  supersedes_event_id: z.string().nullable(),
  updated_at: z.number(),
});

const tombstoneRowSchema = z.object({
  target_event_id: z.string(),
  replacement_event_id: z.string().nullable(),
  reason: z.string(),
  recorded_at: z.number(),
});

const normalizeText = (value: string): string => value
  .replaceAll("\u0000", "")
  .replaceAll("\r\n", "\n")
  .trim();

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function stableIdentity(input: CaptureMemoryItemInput, title: string): string {
  const explicit = input.eventId?.trim();
  if (explicit) return `event:${explicit}`;
  const external = input.externalId?.trim();
  if (external) return `external:${input.sourceId.trim()}\u001f${input.accountId?.trim() ?? ""}\u001f${external}`;
  return `derived:${input.sourceId.trim()}\u001f${input.accountId?.trim() ?? ""}\u001f${input.kind.trim()}\u001f${input.occurredAt}\u001f${title.toLocaleLowerCase()}`;
}

function eventIdFor(botId: string, identityKey: string): string {
  return `omb_evt_${sha256(`${botId}\u001f${identityKey}`).slice(0, 48)}`;
}

function serializeMetadata(metadata: JsonValue | undefined): string | null {
  if (metadata === undefined) return null;
  const result = JSON.stringify(metadata);
  if (result.length > 100_000) throw new Error("Capture metadata is too large");
  return result;
}

function itemFromRow(row: unknown): CaptureMemoryItem {
  const parsed = itemRowSchema.parse(row);
  return {
    eventId: parsed.event_id,
    botId: parsed.bot_id,
    sectionId: parsed.section_id,
    sourceId: parsed.source_id,
    accountId: parsed.account_id,
    kind: parsed.kind,
    title: parsed.title,
    body: parsed.body,
    occurredAt: parsed.occurred_at,
    capturedAt: parsed.captured_at,
    sensitivity: sensitivitySchema.parse(parsed.sensitivity),
    state: stateSchema.parse(parsed.state),
    contentHash: parsed.content_hash,
    identityKey: parsed.identity_key,
    evidenceRef: parsed.evidence_ref,
    payloadRef: parsed.payload_ref,
    metadata: parsed.metadata_json === null ? null : parseJson(parsed.metadata_json),
    supersedesEventId: parsed.supersedes_event_id,
    updatedAt: parsed.updated_at,
  };
}

function ftsQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 16) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

/**
 * Durable, local-first memory for normalized capture records.
 *
 * The FTS table is maintained in the same transaction as the canonical row.
 * Corrections never delete history: a tombstone records the target and the
 * replacement, while ordinary search only returns the current active view.
 */
export class CaptureMemory {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(options: { file?: string; now?: () => number } = {}) {
    const file = options.file ?? join(DATA_DIR, "capture.db");
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.now = options.now ?? Date.now;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capture_memory_items (
        event_id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        section_id TEXT,
        source_id TEXT NOT NULL,
        account_id TEXT,
        identity_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        occurred_at INTEGER NOT NULL,
        captured_at INTEGER NOT NULL,
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'internal', 'sensitive', 'restricted')),
        state TEXT NOT NULL CHECK (state IN ('active', 'tombstone')),
        content_hash TEXT NOT NULL,
        evidence_ref TEXT,
        payload_ref TEXT,
        metadata_json TEXT,
        supersedes_event_id TEXT,
        updated_at INTEGER NOT NULL,
        UNIQUE (bot_id, identity_key)
      );
      CREATE INDEX IF NOT EXISTS capture_memory_items_bot_time
        ON capture_memory_items (bot_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS capture_memory_items_source_time
        ON capture_memory_items (source_id, account_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS capture_memory_items_section_time
        ON capture_memory_items (section_id, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS capture_memory_tombstones (
        target_event_id TEXT PRIMARY KEY,
        replacement_event_id TEXT,
        reason TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS capture_memory_fts USING fts5(
        event_id UNINDEXED,
        title,
        body
      );
    `);
  }

  upsert(rawInput: CaptureMemoryItemInput): CaptureMemoryUpserted {
    const input = captureMemoryItemInputSchema.parse(rawInput);
    const botId = normalizeText(input.botId);
    const sourceId = normalizeText(input.sourceId);
    const accountId = input.accountId ? normalizeText(input.accountId) : null;
    const sectionId = input.sectionId ? normalizeText(input.sectionId) : null;
    const title = normalizeText(input.title);
    const body = input.body === undefined ? null : normalizeText(input.body);
    const identityKey = stableIdentity({ ...input, botId, sourceId, accountId: accountId ?? undefined }, title);
    // Provider ids are identity material, not primary keys. Namespacing the
    // stored id by bot prevents a colliding provider id from overwriting a
    // different bot's record through SQLite's global primary key.
    const eventId = eventIdFor(botId, identityKey);
    const contentHash = sha256([title, body ?? "", input.kind.trim(), input.occurredAt].join("\u001f"));
    const normalized: NormalizedCaptureMemoryItem = {
      eventId,
      botId,
      sectionId,
      sourceId,
      accountId,
      identityKey,
      kind: normalizeText(input.kind),
      title,
      body,
      occurredAt: input.occurredAt,
      capturedAt: input.capturedAt ?? this.now(),
      sensitivity: input.sensitivity,
      contentHash,
      evidenceRef: input.evidenceRef ? normalizeText(input.evidenceRef) : null,
      payloadRef: input.payloadRef ? normalizeText(input.payloadRef) : null,
      metadataJson: serializeMetadata(input.metadata),
      supersedesEventId: null,
      updatedAt: this.now(),
    };
    return this.transaction(() => this.upsertNormalized(normalized));
  }

  correct(targetEventId: string, replacement: CaptureMemoryItemInput, reason: string): CaptureMemoryCorrection {
    const target = this.get(targetEventId);
    if (!target) throw new Error(`Capture event not found: ${targetEventId}`);
    const input = captureMemoryItemInputSchema.parse(replacement);
    if (input.botId.trim() !== target.botId) throw new Error("Capture correction must stay within the original bot");
    const normalized = this.normalizeForCorrection(input, target.eventId);
    const safeReason = normalizeText(reason).slice(0, 2_000);
    if (!safeReason) throw new Error("Capture correction needs a reason");
    const recordedAt = this.now();
    return this.transaction(() => {
      this.upsertNormalized(normalized);
      this.db.prepare(`
        INSERT INTO capture_memory_tombstones (target_event_id, replacement_event_id, reason, recorded_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(target_event_id) DO UPDATE SET
          replacement_event_id = excluded.replacement_event_id,
          reason = excluded.reason,
          recorded_at = excluded.recorded_at
      `).run(target.eventId, normalized.eventId, safeReason, recordedAt);
      this.db.prepare("UPDATE capture_memory_items SET state = 'tombstone', updated_at = ? WHERE event_id = ?")
        .run(recordedAt, target.eventId);
      this.rebuildFts(target.eventId);
      return {
        targetEventId: target.eventId,
        replacementEventId: normalized.eventId,
        reason: safeReason,
        recordedAt,
      };
    });
  }

  tombstone(eventId: string, reason: string): CaptureMemoryTombstone {
    const target = this.get(eventId);
    if (!target) throw new Error(`Capture event not found: ${eventId}`);
    const safeReason = normalizeText(reason).slice(0, 2_000);
    if (!safeReason) throw new Error("Capture tombstone needs a reason");
    const recordedAt = this.now();
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO capture_memory_tombstones (target_event_id, replacement_event_id, reason, recorded_at)
        VALUES (?, NULL, ?, ?)
        ON CONFLICT(target_event_id) DO UPDATE SET
          replacement_event_id = NULL,
          reason = excluded.reason,
          recorded_at = excluded.recorded_at
      `).run(eventId, safeReason, recordedAt);
      this.db.prepare("UPDATE capture_memory_items SET state = 'tombstone', updated_at = ? WHERE event_id = ?")
        .run(recordedAt, eventId);
      this.rebuildFts(eventId);
      return { targetEventId: eventId, replacementEventId: null, reason: safeReason, recordedAt };
    });
  }

  get(eventId: string): CaptureMemoryItem | null {
    const row = this.db.prepare(`SELECT
      event_id, bot_id, section_id, source_id, account_id, kind, title, body,
      occurred_at, captured_at, sensitivity, state, content_hash, identity_key,
      evidence_ref, payload_ref, metadata_json, supersedes_event_id, updated_at
      FROM capture_memory_items WHERE event_id = ?`).get(eventId);
    return row === undefined ? null : itemFromRow(row);
  }

  tombstoneFor(eventId: string): CaptureMemoryTombstone | null {
    const row = this.db.prepare(`
      SELECT target_event_id, replacement_event_id, reason, recorded_at
      FROM capture_memory_tombstones WHERE target_event_id = ?
    `).get(eventId);
    if (row === undefined) return null;
    const parsed = tombstoneRowSchema.parse(row);
    return {
      targetEventId: parsed.target_event_id,
      replacementEventId: parsed.replacement_event_id,
      reason: parsed.reason,
      recordedAt: parsed.recorded_at,
    };
  }

  search(options: CaptureMemorySearchOptions = {}): CaptureMemorySearchResult[] {
    const limit = Math.min(100, Math.max(1, Math.round(options.limit ?? 25)));
    const where = ["i.state = 'active'"];
    const params: Array<string | number> = [];
    if (!options.includeSensitive) where.push("i.sensitivity IN ('public', 'internal')");
    if (options.botId) { where.push("i.bot_id = ?"); params.push(options.botId.trim()); }
    if (options.sectionId) { where.push("i.section_id = ?"); params.push(options.sectionId.trim()); }
    if (options.sourceId) { where.push("i.source_id = ?"); params.push(options.sourceId.trim()); }
    if (options.sourceIds && options.sourceIds.length > 0) {
      const sourceIds = options.sourceIds.map((sourceId) => sourceId.trim()).filter(Boolean).slice(0, 50);
      if (sourceIds.length > 0) {
        where.push(`i.source_id IN (${sourceIds.map(() => "?").join(",")})`);
        params.push(...sourceIds);
      }
    }
    if (options.accountId) { where.push("i.account_id = ?"); params.push(options.accountId.trim()); }
    if (options.kind) { where.push("i.kind = ?"); params.push(options.kind.trim()); }
    if (options.accountPrefix) { where.push("i.account_id LIKE ?"); params.push(`${options.accountPrefix.trim()}%`); }
    if (options.since !== undefined) { where.push("i.occurred_at >= ?"); params.push(options.since); }
    if (options.until !== undefined) { where.push("i.occurred_at <= ?"); params.push(options.until); }
    const match = options.query ? ftsQuery(options.query) : null;
    const from = match === null
      ? "capture_memory_items i"
      : "capture_memory_items i JOIN capture_memory_fts f ON f.event_id = i.event_id";
    if (match !== null) { where.push("f.capture_memory_fts MATCH ?"); params.push(match); }
    params.push(limit);
    const rows = this.db.prepare(`SELECT
      i.event_id, i.bot_id, i.section_id, i.source_id, i.account_id, i.kind, i.title, i.body,
      i.occurred_at, i.captured_at, i.sensitivity, i.state, i.content_hash, i.identity_key,
      i.evidence_ref, i.payload_ref, i.metadata_json, i.supersedes_event_id, i.updated_at
      FROM ${from} WHERE ${where.join(" AND ")}
      ORDER BY i.occurred_at DESC, i.event_id ASC LIMIT ?`).all(...params);
    return rows.map((row): CaptureMemorySearchResult => {
      const item = itemFromRow(row);
      return {
        item,
        provenance: {
          sourceId: item.sourceId,
          accountId: item.accountId,
          occurredAt: item.occurredAt,
          capturedAt: item.capturedAt,
          sensitivity: item.sensitivity,
          evidenceRef: item.evidenceRef,
          payloadRef: item.payloadRef,
        },
      };
    });
  }

  /** Chief retrieval is exact-section and excludes sensitive records by default. */
  searchForChief(sectionId: string, options: Omit<CaptureMemorySearchOptions, "sectionId" | "includeSensitive"> = {}): CaptureMemorySearchResult[] {
    const safeSection = normalizeText(sectionId);
    if (!safeSection) throw new Error("Chief memory retrieval needs a section");
    return this.search({ ...options, sectionId: safeSection, includeSensitive: false });
  }

  statistics(): {
    activeItems: number;
    tombstones: number;
    sensitiveItems: number;
    oldestOccurredAt: number | null;
    newestOccurredAt: number | null;
    bySource: Array<{ sourceId: string; count: number }>;
  } {
    const totals = z.object({
      active_items: z.number(),
      tombstones: z.number(),
      sensitive_items: z.number(),
      oldest_occurred_at: z.number().nullable(),
      newest_occurred_at: z.number().nullable(),
    }).parse(this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END), 0) AS active_items,
        COALESCE(SUM(CASE WHEN state = 'tombstone' THEN 1 ELSE 0 END), 0) AS tombstones,
        COALESCE(SUM(CASE WHEN state = 'active' AND sensitivity IN ('sensitive', 'restricted') THEN 1 ELSE 0 END), 0) AS sensitive_items,
        MIN(CASE WHEN state = 'active' THEN occurred_at END) AS oldest_occurred_at,
        MAX(CASE WHEN state = 'active' THEN occurred_at END) AS newest_occurred_at
      FROM capture_memory_items
    `).get());
    const sourceRow = z.object({ source_id: z.string(), count: z.number() });
    const bySource = this.db.prepare(`
      SELECT source_id, COUNT(*) AS count FROM capture_memory_items
      WHERE state = 'active' GROUP BY source_id ORDER BY count DESC, source_id ASC
    `).all().map((row) => {
      const parsed = sourceRow.parse(row);
      return { sourceId: parsed.source_id, count: parsed.count };
    });
    return {
      activeItems: totals.active_items,
      tombstones: totals.tombstones,
      sensitiveItems: totals.sensitive_items,
      oldestOccurredAt: totals.oldest_occurred_at,
      newestOccurredAt: totals.newest_occurred_at,
      bySource,
    };
  }

  close(): void { this.db.close(); }

  private normalizeForCorrection(input: CaptureMemoryItemInput, targetEventId: string): NormalizedCaptureMemoryItem {
    const botId = normalizeText(input.botId);
    const sourceId = normalizeText(input.sourceId);
    const accountId = input.accountId ? normalizeText(input.accountId) : null;
    const title = normalizeText(input.title);
    const body = input.body === undefined ? null : normalizeText(input.body);
    const identityKey = `correction:${targetEventId}:${sha256([title, body ?? "", input.occurredAt].join("\u001f"))}`;
    const contentHash = sha256([title, body ?? "", input.kind.trim(), input.occurredAt].join("\u001f"));
    return {
      eventId: eventIdFor(botId, identityKey),
      botId,
      sectionId: input.sectionId ? normalizeText(input.sectionId) : null,
      sourceId,
      accountId,
      identityKey,
      kind: normalizeText(input.kind),
      title,
      body,
      occurredAt: input.occurredAt,
      capturedAt: input.capturedAt ?? this.now(),
      sensitivity: input.sensitivity,
      contentHash,
      evidenceRef: input.evidenceRef ? normalizeText(input.evidenceRef) : null,
      payloadRef: input.payloadRef ? normalizeText(input.payloadRef) : null,
      metadataJson: serializeMetadata(input.metadata),
      supersedesEventId: targetEventId,
      updatedAt: this.now(),
    };
  }

  private upsertNormalized(item: NormalizedCaptureMemoryItem): CaptureMemoryUpserted {
    const existingByEvent = this.get(item.eventId);
    const existingByIdentityRow = this.db.prepare(`
      SELECT event_id, bot_id, section_id, source_id, account_id, kind, title, body,
        occurred_at, captured_at, sensitivity, state, content_hash, identity_key,
        evidence_ref, payload_ref, metadata_json, supersedes_event_id, updated_at
      FROM capture_memory_items WHERE bot_id = ? AND identity_key = ?
    `).get(item.botId, item.identityKey);
    const identityMatch = existingByIdentityRow === undefined ? null : itemFromRow(existingByIdentityRow);
    const existing = existingByEvent ?? identityMatch;
    // A source may start supplying an explicit id after earlier derived ids
    // were stored. Preserve the first canonical event id instead of creating
    // a second row or violating the bot/identity uniqueness constraint.
    const canonicalItem = identityMatch !== null && existingByEvent === null && identityMatch.eventId !== item.eventId
      ? { ...item, eventId: identityMatch.eventId }
      : item;
    const tombstone = this.tombstoneFor(canonicalItem.eventId);
    if (tombstone) {
      const preserved = this.get(canonicalItem.eventId);
      if (!preserved) throw new Error("Capture tombstone has no preserved target row");
      return { status: "ignored-tombstone", item: preserved };
    }
    const status: CaptureMemoryUpserted["status"] = existing === null
      ? "inserted"
      : existing.contentHash === canonicalItem.contentHash ? "deduplicated" : "updated";
    this.db.prepare(`
      INSERT INTO capture_memory_items (
        event_id, bot_id, section_id, source_id, account_id, identity_key, kind,
        title, body, occurred_at, captured_at, sensitivity, state, content_hash,
        evidence_ref, payload_ref, metadata_json, supersedes_event_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        bot_id = excluded.bot_id,
        section_id = excluded.section_id,
        source_id = excluded.source_id,
        account_id = excluded.account_id,
        identity_key = excluded.identity_key,
        kind = excluded.kind,
        title = excluded.title,
        body = excluded.body,
        occurred_at = excluded.occurred_at,
        captured_at = excluded.captured_at,
        sensitivity = excluded.sensitivity,
        state = excluded.state,
        content_hash = excluded.content_hash,
        evidence_ref = excluded.evidence_ref,
        payload_ref = excluded.payload_ref,
        metadata_json = excluded.metadata_json,
        supersedes_event_id = excluded.supersedes_event_id,
        updated_at = excluded.updated_at
    `).run(
      canonicalItem.eventId, canonicalItem.botId, canonicalItem.sectionId, canonicalItem.sourceId, canonicalItem.accountId, canonicalItem.identityKey,
      canonicalItem.kind, canonicalItem.title, canonicalItem.body, canonicalItem.occurredAt, canonicalItem.capturedAt, canonicalItem.sensitivity,
      canonicalItem.contentHash, canonicalItem.evidenceRef, canonicalItem.payloadRef, canonicalItem.metadataJson,
      canonicalItem.supersedesEventId, canonicalItem.updatedAt,
    );
    this.rebuildFts(canonicalItem.eventId);
    const persisted = this.get(canonicalItem.eventId);
    if (!persisted) throw new Error("Capture item disappeared after upsert");
    return { status, item: persisted };
  }

  private rebuildFts(eventId: string): void {
    this.db.prepare("DELETE FROM capture_memory_fts WHERE event_id = ?").run(eventId);
    const row = this.db.prepare("SELECT event_id, title, body FROM capture_memory_items WHERE event_id = ? AND state = 'active'").get(eventId);
    if (row === undefined) return;
    const parsed = z.object({ event_id: z.string(), title: z.string(), body: z.string().nullable() }).parse(row);
    this.db.prepare("INSERT INTO capture_memory_fts (event_id, title, body) VALUES (?, ?, ?)")
      .run(parsed.event_id, parsed.title, parsed.body ?? "");
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

interface NormalizedCaptureMemoryItem {
  eventId: string;
  botId: string;
  sectionId: string | null;
  sourceId: string;
  accountId: string | null;
  identityKey: string;
  kind: string;
  title: string;
  body: string | null;
  occurredAt: number;
  capturedAt: number;
  sensitivity: CaptureMemorySensitivity;
  contentHash: string;
  evidenceRef: string | null;
  payloadRef: string | null;
  metadataJson: string | null;
  supersedesEventId: string | null;
  updatedAt: number;
}
