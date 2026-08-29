import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import { parseJson, type JsonValue } from "./schema.ts";

export const WORLD_ENTITY_KINDS = ["person", "organization", "project", "place", "account", "device", "topic", "other"] as const;
export type WorldEntityKind = (typeof WORLD_ENTITY_KINDS)[number];
export const WORLD_SENSITIVITIES = ["public", "internal", "sensitive", "restricted"] as const;
export type WorldSensitivity = (typeof WORLD_SENSITIVITIES)[number];

const entityInputSchema = z.object({
  kind: z.enum(WORLD_ENTITY_KINDS),
  name: z.string().trim().min(1).max(300),
  aliases: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
});

const claimObjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), value: z.string().trim().min(1).max(10_000) }),
  z.object({ kind: z.literal("entity"), entity: entityInputSchema }),
]);

export const worldClaimInputSchema = z.object({
  botId: z.string().trim().min(1).max(120),
  subject: entityInputSchema,
  predicate: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,95}$/),
  object: claimObjectSchema,
  sourceId: z.string().trim().min(1).max(120),
  accountId: z.string().trim().max(240).optional(),
  observedAt: z.number().finite(),
  validFrom: z.number().finite().optional(),
  validUntil: z.number().finite().optional(),
  ttlMs: z.number().int().positive().max(365 * 24 * 60 * 60 * 1_000).optional(),
  confidence: z.number().min(0).max(1).default(1),
  sensitivity: z.enum(WORLD_SENSITIVITIES),
  evidenceRef: z.string().trim().min(1).max(2_000),
  metadata: z.json().optional(),
});
export type WorldClaimInput = z.input<typeof worldClaimInputSchema>;

export const worldResolveInputSchema = z.object({
  botId: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(1).max(300).optional(),
  subjectKind: z.enum(WORLD_ENTITY_KINDS).optional(),
  predicate: z.string().trim().max(96).optional(),
  includeSensitive: z.boolean().optional(),
  includeStale: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type WorldResolveInput = z.input<typeof worldResolveInputSchema>;

export interface WorldEntity {
  id: string;
  kind: WorldEntityKind;
  name: string;
  aliases: string[];
}

export interface WorldClaim {
  id: string;
  subject: WorldEntity;
  predicate: string;
  object: { kind: "value"; value: string } | { kind: "entity"; entity: WorldEntity };
  sourceId: string;
  accountId: string | null;
  observedAt: number;
  validFrom: number | null;
  validUntil: number | null;
  staleAfter: number | null;
  freshness: "fresh" | "stale";
  confidence: number;
  sensitivity: WorldSensitivity;
  evidenceRef: string;
  metadata: JsonValue | null;
}

export interface WorldResolution {
  claims: WorldClaim[];
  conflicts: Array<{
    subjectId: string;
    predicate: string;
    claimIds: string[];
    values: string[];
  }>;
}

export interface WorldStatistics {
  entities: number;
  activeClaims: number;
  conflicts: number;
  staleClaims: number;
  latestObservedAt: number | null;
}

const claimRowSchema = z.object({
  id: z.string(), predicate: z.string(), object_kind: z.enum(["value", "entity"]), object_value: z.string().nullable(),
  object_entity_id: z.string().nullable(), source_id: z.string(), account_id: z.string().nullable(), observed_at: z.number(),
  valid_from: z.number().nullable(), valid_until: z.number().nullable(), stale_after: z.number().nullable(), confidence: z.number(),
  sensitivity: z.enum(WORLD_SENSITIVITIES), evidence_ref: z.string(), metadata_json: z.string().nullable(),
  subject_id: z.string(), subject_kind: z.enum(WORLD_ENTITY_KINDS), subject_name: z.string(), subject_aliases: z.string(),
  object_entity_kind: z.enum(WORLD_ENTITY_KINDS).nullable(), object_entity_name: z.string().nullable(), object_entity_aliases: z.string().nullable(),
});
const countRowSchema = z.object({ count: z.number() });
const activeStatisticsRowSchema = z.object({ count: z.number(), latest: z.number().nullable() });

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function metadataJson(value: JsonValue | undefined): string | null {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized.length > 100_000) throw new Error("World-model metadata is too large");
  return serialized;
}

/**
 * A local world model for durable entities and source-backed claims.
 *
 * Callers only assert evidence and resolve the current view. The module owns
 * alias merging, same-source supersession, cross-source conflict detection,
 * freshness, sensitivity filtering, and provenance retention.
 */
export class WorldModel {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(options: { file?: string; now?: () => number } = {}) {
    const file = options.file ?? join(DATA_DIR, "world-model.db");
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.now = options.now ?? Date.now;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS world_entities (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(bot_id, kind, normalized_name)
      );
      CREATE INDEX IF NOT EXISTS world_entities_bot_kind ON world_entities(bot_id, kind, normalized_name);
      CREATE TABLE IF NOT EXISTS world_claims (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        subject_id TEXT NOT NULL REFERENCES world_entities(id),
        predicate TEXT NOT NULL,
        object_kind TEXT NOT NULL CHECK(object_kind IN ('value','entity')),
        object_value TEXT,
        object_entity_id TEXT REFERENCES world_entities(id),
        source_id TEXT NOT NULL,
        account_id TEXT,
        observed_at INTEGER NOT NULL,
        valid_from INTEGER,
        valid_until INTEGER,
        stale_after INTEGER,
        confidence REAL NOT NULL,
        sensitivity TEXT NOT NULL,
        evidence_ref TEXT NOT NULL,
        metadata_json TEXT,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','superseded')),
        superseded_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS world_claims_lookup ON world_claims(bot_id, subject_id, predicate, status, observed_at DESC);
    `);
  }

  assert(raw: WorldClaimInput): { status: "inserted" | "deduplicated" | "superseded"; claim: WorldClaim } {
    const input = worldClaimInputSchema.parse(raw);
    if (input.validFrom !== undefined && input.validUntil !== undefined && input.validUntil < input.validFrom) {
      throw new Error("World-model validUntil cannot precede validFrom");
    }
    const subject = this.upsertEntity(input.botId, input.subject);
    const objectEntity = input.object.kind === "entity" ? this.upsertEntity(input.botId, input.object.entity) : null;
    const objectValue = input.object.kind === "value" ? input.object.value.trim() : objectEntity?.id ?? "";
    const contentHash = hash(`${subject.id}\u001f${input.predicate}\u001f${input.object.kind}\u001f${normalized(objectValue)}`);
    const accountId = input.accountId?.trim() || null;
    const existingRows = this.db.prepare(`
      SELECT id, content_hash, observed_at FROM world_claims
      WHERE bot_id = ? AND subject_id = ? AND predicate = ? AND source_id = ?
        AND COALESCE(account_id, '') = COALESCE(?, '') AND status = 'active'
      ORDER BY observed_at DESC
    `).all(input.botId, subject.id, input.predicate, input.sourceId, accountId) as Array<{ id: string; content_hash: string; observed_at: number }>;
    const duplicate = existingRows.find((row) => row.content_hash === contentHash);
    const now = this.now();
    if (duplicate) {
      this.db.prepare(`UPDATE world_claims SET observed_at = MAX(observed_at, ?), stale_after = ?, confidence = MAX(confidence, ?), evidence_ref = ?, metadata_json = ?, updated_at = ? WHERE id = ?`)
        .run(input.observedAt, input.ttlMs ? input.observedAt + input.ttlMs : null, input.confidence, input.evidenceRef, metadataJson(input.metadata), now, duplicate.id);
      return { status: "deduplicated", claim: this.claimById(duplicate.id) };
    }
    const claimId = `omb_claim_${hash(`${input.botId}\u001f${contentHash}\u001f${input.sourceId}\u001f${accountId ?? ""}\u001f${input.observedAt}`).slice(0, 48)}`;
    this.db.prepare(`
      INSERT INTO world_claims (
        id, bot_id, subject_id, predicate, object_kind, object_value, object_entity_id, source_id, account_id,
        observed_at, valid_from, valid_until, stale_after, confidence, sensitivity, evidence_ref, metadata_json,
        content_hash, status, superseded_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)
    `).run(claimId, input.botId, subject.id, input.predicate, input.object.kind,
      input.object.kind === "value" ? input.object.value.trim() : null, objectEntity?.id ?? null, input.sourceId, accountId,
      input.observedAt, input.validFrom ?? null, input.validUntil ?? null, input.ttlMs ? input.observedAt + input.ttlMs : null,
      input.confidence, input.sensitivity, input.evidenceRef, metadataJson(input.metadata), contentHash, now, now);
    let superseded = false;
    for (const row of existingRows) {
      if (row.observed_at > input.observedAt) continue;
      this.db.prepare("UPDATE world_claims SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?")
        .run(claimId, now, row.id);
      superseded = true;
    }
    return { status: superseded ? "superseded" : "inserted", claim: this.claimById(claimId) };
  }

  resolve(raw: WorldResolveInput): WorldResolution {
    const input = worldResolveInputSchema.parse(raw);
    const clauses = ["c.bot_id = ?", "c.status = 'active'"];
    const values: Array<string | number> = [input.botId];
    if (!input.includeSensitive) clauses.push("c.sensitivity IN ('public','internal')");
    if (!input.includeStale) {
      clauses.push("(c.stale_after IS NULL OR c.stale_after >= ?)");
      values.push(this.now());
    }
    if (input.subjectKind) { clauses.push("s.kind = ?"); values.push(input.subjectKind); }
    if (input.predicate) { clauses.push("c.predicate = ?"); values.push(input.predicate); }
    if (input.subject) {
      clauses.push("(s.normalized_name = ? OR EXISTS (SELECT 1 FROM json_each(s.aliases_json) WHERE lower(value) = ?))");
      values.push(normalized(input.subject), normalized(input.subject));
    }
    values.push(input.limit ?? 100);
    const rows = this.db.prepare(`${this.claimSelect()} WHERE ${clauses.join(" AND ")} ORDER BY c.observed_at DESC LIMIT ?`).all(...values);
    const claims = rows.map((row) => this.claimFromRow(row));
    const groups = new Map<string, WorldClaim[]>();
    for (const claim of claims) {
      const key = `${claim.subject.id}\u001f${claim.predicate}`;
      groups.set(key, [...(groups.get(key) ?? []), claim]);
    }
    const conflicts: WorldResolution["conflicts"] = [];
    for (const [key, group] of groups) {
      const rendered = new Map(group.map((claim) => [this.objectKey(claim), claim]));
      if (rendered.size < 2) continue;
      const [subjectId, predicate] = key.split("\u001f");
      conflicts.push({
        subjectId: subjectId ?? "",
        predicate: predicate ?? "",
        claimIds: group.map((claim) => claim.id),
        values: [...rendered.values()].map((claim) => this.objectLabel(claim)),
      });
    }
    return { claims, conflicts };
  }

  statistics(botId?: string): WorldStatistics {
    const owner = botId?.trim();
    const entityWhere = owner ? " WHERE bot_id = ?" : "";
    const claimOwner = owner ? " AND bot_id = ?" : "";
    const ownerArgs = owner ? [owner] : [];
    const entities = countRowSchema.parse(this.db.prepare(`SELECT COUNT(*) count FROM world_entities${entityWhere}`).get(...ownerArgs)).count;
    const active = activeStatisticsRowSchema.parse(this.db.prepare(`SELECT COUNT(*) count, MAX(observed_at) latest FROM world_claims WHERE status = 'active'${claimOwner}`).get(...ownerArgs));
    const staleClaims = countRowSchema.parse(this.db.prepare(`SELECT COUNT(*) count FROM world_claims WHERE status = 'active' AND stale_after IS NOT NULL AND stale_after < ?${claimOwner}`).get(this.now(), ...ownerArgs)).count;
    const conflicts = countRowSchema.parse(this.db.prepare(`SELECT COUNT(*) count FROM (SELECT subject_id, predicate FROM world_claims WHERE status='active'${claimOwner} GROUP BY subject_id, predicate HAVING COUNT(DISTINCT content_hash) > 1)`).get(...ownerArgs)).count;
    return { entities, activeClaims: active.count, conflicts, staleClaims, latestObservedAt: active.latest };
  }

  close(): void { this.db.close(); }

  private upsertEntity(botId: string, input: z.infer<typeof entityInputSchema>): WorldEntity {
    const name = input.name.trim();
    const normalizedName = normalized(name);
    const id = `omb_entity_${hash(`${botId}\u001f${input.kind}\u001f${normalizedName}`).slice(0, 40)}`;
    const existing = this.db.prepare("SELECT aliases_json FROM world_entities WHERE bot_id = ? AND kind = ? AND normalized_name = ?")
      .get(botId, input.kind, normalizedName) as { aliases_json: string } | undefined;
    const aliases = new Set<string>(existing ? z.array(z.string()).parse(JSON.parse(existing.aliases_json)) : []);
    for (const alias of input.aliases ?? []) if (normalized(alias) !== normalizedName) aliases.add(alias.trim());
    const now = this.now();
    this.db.prepare(`
      INSERT INTO world_entities (id, bot_id, kind, canonical_name, normalized_name, aliases_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, kind, normalized_name) DO UPDATE SET canonical_name=excluded.canonical_name, aliases_json=excluded.aliases_json, updated_at=excluded.updated_at
    `).run(id, botId, input.kind, name, normalizedName, JSON.stringify([...aliases]), now, now);
    return { id, kind: input.kind, name, aliases: [...aliases] };
  }

  private claimById(id: string): WorldClaim {
    const row = this.db.prepare(`${this.claimSelect()} WHERE c.id = ?`).get(id);
    if (!row) throw new Error(`World-model claim not found: ${id}`);
    return this.claimFromRow(row);
  }

  private claimSelect(): string {
    return `SELECT c.*, s.kind subject_kind, s.canonical_name subject_name, s.aliases_json subject_aliases,
      o.kind object_entity_kind, o.canonical_name object_entity_name, o.aliases_json object_entity_aliases
      FROM world_claims c JOIN world_entities s ON s.id = c.subject_id LEFT JOIN world_entities o ON o.id = c.object_entity_id`;
  }

  private claimFromRow(row: unknown): WorldClaim {
    const parsed = claimRowSchema.parse(row);
    const subject: WorldEntity = { id: parsed.subject_id, kind: parsed.subject_kind, name: parsed.subject_name, aliases: z.array(z.string()).parse(JSON.parse(parsed.subject_aliases)) };
    const object = parsed.object_kind === "value"
      ? { kind: "value" as const, value: parsed.object_value ?? "" }
      : { kind: "entity" as const, entity: { id: parsed.object_entity_id ?? "", kind: parsed.object_entity_kind ?? "other", name: parsed.object_entity_name ?? "", aliases: z.array(z.string()).parse(JSON.parse(parsed.object_entity_aliases ?? "[]")) } };
    return {
      id: parsed.id, subject, predicate: parsed.predicate, object, sourceId: parsed.source_id, accountId: parsed.account_id,
      observedAt: parsed.observed_at, validFrom: parsed.valid_from, validUntil: parsed.valid_until, staleAfter: parsed.stale_after,
      freshness: parsed.stale_after !== null && parsed.stale_after < this.now() ? "stale" : "fresh", confidence: parsed.confidence,
      sensitivity: parsed.sensitivity, evidenceRef: parsed.evidence_ref, metadata: parsed.metadata_json === null ? null : parseJson(parsed.metadata_json),
    };
  }

  private objectKey(claim: WorldClaim): string { return claim.object.kind === "value" ? normalized(claim.object.value) : claim.object.entity.id; }
  private objectLabel(claim: WorldClaim): string { return claim.object.kind === "value" ? claim.object.value : claim.object.entity.name; }
}
