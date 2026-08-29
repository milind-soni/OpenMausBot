import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import { parseJson, type JsonValue } from "./schema.ts";

export const WORK_OBLIGATION_STATUSES = ["open", "in_progress", "blocked", "completed", "cancelled"] as const;
export type WorkObligationStatus = (typeof WORK_OBLIGATION_STATUSES)[number];
export const WORK_APPROVAL_STATUSES = ["pending", "approved", "rejected", "revoked"] as const;
export type WorkApprovalStatus = (typeof WORK_APPROVAL_STATUSES)[number];
export const WORK_DEADLINE_STATUSES = ["active", "met", "missed", "cancelled"] as const;
export type WorkDeadlineStatus = (typeof WORK_DEADLINE_STATUSES)[number];

export interface WorkExternalIdentity {
  source: string;
  id: string;
}
export interface WorkOwner {
  id: string;
  label?: string;
}

export interface WorkEvidence {
  id: string;
  obligationId: string;
  kind: string;
  reference: string;
  summary: string;
  recordedAt: number;
  metadata: JsonValue | null;
}

export interface WorkApproval {
  id: string;
  obligationId: string;
  key: string;
  prompt: string;
  status: WorkApprovalStatus;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  payload: JsonValue | null;
  payloadHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkDeadline {
  id: string;
  obligationId: string;
  key: string;
  label: string;
  dueAt: number;
  status: WorkDeadlineStatus;
  createdAt: number;
  updatedAt: number;
}

export interface WorkObligation {
  id: string;
  externalIdentity: WorkExternalIdentity;
  title: string;
  description: string | null;
  status: WorkObligationStatus;
  owner: WorkOwner | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  cancelledAt: number | null;
  metadata: JsonValue | null;
  approvals: WorkApproval[];
  deadlines: WorkDeadline[];
  evidence: WorkEvidence[];
}

export interface CreateObligationInput {
  title: string;
  description?: string;
  externalIdentity?: WorkExternalIdentity;
  /** Convenience aliases for callers importing an external record. */
  source?: string;
  externalId?: string;
  externalKey?: string;
  ownerId?: string | null;
  ownerLabel?: string;
  metadata?: JsonValue;
  deadline?: { key?: string; label: string; dueAt: number };
  /** Initial children are committed with the obligation so import adapters
   * cannot expose a half-populated work record. */
  approval?: AddApprovalInput;
  evidence?: AddEvidenceInput;
}

export interface UpdateObligationInput {
  expectedVersion?: number;
  title?: string;
  description?: string | null;
  ownerId?: string | null;
  ownerLabel?: string;
  metadata?: JsonValue | null;
}

export interface AddApprovalInput {
  key: string;
  prompt: string;
  requestedBy?: string;
  payload?: JsonValue;
}

export interface AddDeadlineInput {
  key?: string;
  label: string;
  dueAt: number;
}

export interface AddEvidenceInput {
  kind: string;
  reference: string;
  summary: string;
  recordedAt?: number;
  metadata?: JsonValue;
}

export interface OpenWorkQuery {
  ownerId?: string;
  statuses?: WorkObligationStatus[];
  asOf?: number;
  limit?: number;
}

export interface OpenWorkProjection {
  generatedAt: number;
  obligations: WorkObligation[];
  pendingApprovals: WorkApproval[];
  deadlines: WorkDeadline[];
}

export interface WorkLockStoreInterface {
  createObligation(input: CreateObligationInput): { status: "created" | "deduplicated"; obligation: WorkObligation };
  getObligation(id: string): WorkObligation | null;
  updateObligation(id: string, input: UpdateObligationInput): WorkObligation;
  transitionObligation(id: string, status: WorkObligationStatus, expectedVersion?: number): WorkObligation;
  completeObligation(id: string, expectedVersion?: number): WorkObligation;
  cancelObligation(id: string, expectedVersion?: number): WorkObligation;
  setOwner(id: string, owner: WorkOwner | null, expectedVersion?: number): WorkObligation;
  addApproval(id: string, input: AddApprovalInput, expectedVersion?: number): { status: "created" | "deduplicated"; approval: WorkApproval; obligation: WorkObligation };
  decideApproval(id: string, approvalId: string, status: "approved" | "rejected" | "revoked", decidedBy?: string, expectedVersion?: number): { approval: WorkApproval; obligation: WorkObligation };
  addDeadline(id: string, input: AddDeadlineInput, expectedVersion?: number): { status: "created" | "deduplicated"; deadline: WorkDeadline; obligation: WorkObligation };
  decideDeadline(id: string, deadlineId: string, status: "met" | "missed" | "cancelled", expectedVersion?: number): { deadline: WorkDeadline; obligation: WorkObligation };
  recordEvidence(id: string, input: AddEvidenceInput, expectedVersion?: number): { status: "recorded" | "deduplicated"; evidence: WorkEvidence; obligation: WorkObligation };
  listOpenWork(query?: OpenWorkQuery): OpenWorkProjection;
  close(): void;
}

const identitySchema = z.object({ source: z.string().trim().min(1).max(200), id: z.string().trim().min(1).max(500) });
const createInputSchema = z.object({
  title: z.string().trim().min(1).max(1_000),
  description: z.string().max(20_000).optional(),
  externalIdentity: identitySchema.optional(),
  source: z.string().trim().min(1).max(200).optional(),
  externalId: z.string().trim().min(1).max(500).optional(),
  externalKey: z.string().trim().min(1).max(700).optional(),
  ownerId: z.string().trim().min(1).max(300).nullable().optional(),
  ownerLabel: z.string().trim().max(500).optional(),
  metadata: z.json().optional(),
  deadline: z.object({ key: z.string().trim().min(1).max(300).optional(), label: z.string().trim().min(1).max(500), dueAt: z.number().finite() }).optional(),
  approval: z.object({ key: z.string().trim().min(1).max(300), prompt: z.string().trim().min(1).max(4_000), requestedBy: z.string().trim().min(1).max(300).optional(), payload: z.json().optional() }).optional(),
  evidence: z.object({ kind: z.string().trim().min(1).max(120), reference: z.string().trim().min(1).max(2_000), summary: z.string().trim().min(1).max(4_000), recordedAt: z.number().finite().optional(), metadata: z.json().optional() }).optional(),
});
const updateInputSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(1_000).optional(),
  description: z.string().max(20_000).nullable().optional(),
  ownerId: z.string().trim().min(1).max(300).nullable().optional(),
  ownerLabel: z.string().trim().max(500).optional(),
  metadata: z.json().nullable().optional(),
});
const approvalInputSchema = z.object({ key: z.string().trim().min(1).max(300), prompt: z.string().trim().min(1).max(4_000), requestedBy: z.string().trim().min(1).max(300).optional(), payload: z.json().optional() });
const deadlineInputSchema = z.object({ key: z.string().trim().min(1).max(300).optional(), label: z.string().trim().min(1).max(500), dueAt: z.number().finite() });
const evidenceInputSchema = z.object({ kind: z.string().trim().min(1).max(120), reference: z.string().trim().min(1).max(2_000), summary: z.string().trim().min(1).max(4_000), recordedAt: z.number().finite().optional(), metadata: z.json().optional() });

const obligationRowSchema = z.object({
  id: z.string(), external_namespace: z.string(), external_key: z.string(), title: z.string(), description: z.string().nullable(),
  status: z.enum(WORK_OBLIGATION_STATUSES), owner_id: z.string().nullable(), owner_label: z.string().nullable(), version: z.number(),
  created_at: z.number(), updated_at: z.number(), completed_at: z.number().nullable(), cancelled_at: z.number().nullable(), metadata_json: z.string().nullable(),
});
const approvalRowSchema = z.object({ id: z.string(), obligation_id: z.string(), approval_key: z.string(), prompt: z.string(), status: z.enum(WORK_APPROVAL_STATUSES), requested_by: z.string().nullable(), decided_by: z.string().nullable(), decided_at: z.number().nullable(), payload_json: z.string().nullable(), payload_hash: z.string().nullable(), created_at: z.number(), updated_at: z.number() });
const deadlineRowSchema = z.object({ id: z.string(), obligation_id: z.string(), deadline_key: z.string(), label: z.string(), due_at: z.number(), status: z.enum(WORK_DEADLINE_STATUSES), created_at: z.number(), updated_at: z.number() });
const evidenceRowSchema = z.object({ id: z.string(), obligation_id: z.string(), kind: z.string(), reference: z.string(), summary: z.string(), recorded_at: z.number(), metadata_json: z.string().nullable() });

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const primitive = z.union([z.string(), z.number(), z.boolean()]).safeParse(value);
  if (primitive.success) return JSON.stringify(primitive.data);
  const object = z.record(z.string(), z.json()).parse(value);
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] ?? null)}`).join(",")}}`;
}

function jsonText(value: JsonValue | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = canonicalJson(value);
  if (text.length > 100_000) throw new WorkLockError("payload_too_large", "Work-lock JSON is too large");
  return text;
}

export class WorkLockError extends Error {
  readonly code: "invalid" | "not_found" | "version_conflict" | "illegal_transition" | "approval_pending" | "evidence_required" | "duplicate" | "payload_too_large";
  readonly status: number;

  constructor(code: WorkLockError["code"], message: string) {
    super(message);
    this.name = "WorkLockError";
    this.code = code;
    this.status = code === "not_found" ? 404 : code === "version_conflict" || code === "illegal_transition" || code === "approval_pending" || code === "evidence_required" || code === "duplicate" ? 409 : 400;
  }
}

const noObligationTransitions: readonly WorkObligationStatus[] = [];
const legalObligationTransitions = {
  open: ["in_progress", "blocked", "completed", "cancelled"],
  in_progress: ["blocked", "completed", "cancelled"],
  blocked: ["in_progress", "completed", "cancelled"],
  completed: noObligationTransitions,
  cancelled: noObligationTransitions,
} satisfies { [status in WorkObligationStatus]: readonly WorkObligationStatus[] };

/**
 * Durable work locks: obligations and their approvals, deadlines, evidence,
 * owner, and completion state. The interface deliberately returns a single
 * projection for callers; identity, transactions, version checks, and
 * lifecycle legality stay inside this module.
 */
export class WorkLockStore implements WorkLockStoreInterface {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(options: { file?: string; now?: () => number } = {}) {
    const file = options.file ?? join(DATA_DIR, "work-lock-store.db");
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.now = options.now ?? Date.now;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_obligations (
        id TEXT PRIMARY KEY,
        external_namespace TEXT NOT NULL,
        external_key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL CHECK(status IN ('open','in_progress','blocked','completed','cancelled')),
        owner_id TEXT,
        owner_label TEXT,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        cancelled_at INTEGER,
        metadata_json TEXT,
        UNIQUE(external_namespace, external_key)
      );
      CREATE INDEX IF NOT EXISTS work_obligations_open ON work_obligations(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS work_obligations_owner ON work_obligations(owner_id, status);
      CREATE TABLE IF NOT EXISTS work_approvals (
        id TEXT PRIMARY KEY,
        obligation_id TEXT NOT NULL REFERENCES work_obligations(id) ON DELETE CASCADE,
        approval_key TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','revoked')),
        requested_by TEXT,
        decided_by TEXT,
        decided_at INTEGER,
        payload_json TEXT,
        payload_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(obligation_id, approval_key)
      );
      CREATE INDEX IF NOT EXISTS work_approvals_pending ON work_approvals(status, obligation_id);
      CREATE TABLE IF NOT EXISTS work_deadlines (
        id TEXT PRIMARY KEY,
        obligation_id TEXT NOT NULL REFERENCES work_obligations(id) ON DELETE CASCADE,
        deadline_key TEXT NOT NULL,
        label TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','met','missed','cancelled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(obligation_id, deadline_key)
      );
      CREATE INDEX IF NOT EXISTS work_deadlines_due ON work_deadlines(status, due_at);
      CREATE TABLE IF NOT EXISTS work_evidence (
        id TEXT PRIMARY KEY,
        obligation_id TEXT NOT NULL REFERENCES work_obligations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        reference TEXT NOT NULL,
        summary TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        metadata_json TEXT,
        UNIQUE(obligation_id, kind, reference)
      );
      CREATE INDEX IF NOT EXISTS work_evidence_obligation ON work_evidence(obligation_id, recorded_at DESC);
    `);
  }

  createObligation(raw: CreateObligationInput): { status: "created" | "deduplicated"; obligation: WorkObligation } {
    const input = createInputSchema.parse(raw);
    const identity = this.identity(input);
    const id = `omb_lock_${hash(`${identity.source}\u001f${identity.id}`).slice(0, 48)}`;
    const now = this.now();
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM work_obligations WHERE external_namespace = ? AND external_key = ?").get(identity.source, identity.id);
      if (existing !== undefined) {
        const parsed = z.object({ id: z.string() }).parse(existing);
        return { status: "deduplicated", obligation: this.obligationById(parsed.id) };
      }
      this.db.prepare(`INSERT INTO work_obligations (id, external_namespace, external_key, title, description, status, owner_id, owner_label, version, created_at, updated_at, completed_at, cancelled_at, metadata_json) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 1, ?, ?, NULL, NULL, ?)`).run(
        id, identity.source, identity.id, input.title.trim(), input.description ?? null, input.ownerId ?? null, input.ownerLabel?.trim() ?? null, now, now, jsonText(input.metadata),
      );
      if (input.deadline) {
        const key = normalized(input.deadline.key ?? "primary");
        this.db.prepare("INSERT INTO work_deadlines (id, obligation_id, deadline_key, label, due_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)").run(
          `omb_deadline_${hash(`${id}\u001f${key}`).slice(0, 40)}`, id, key, input.deadline.label.trim(), input.deadline.dueAt, now, now,
        );
      }
      if (input.approval) {
        const key = normalized(input.approval.key);
        const approvalId = `omb_approval_${hash(`${id}\u001f${key}`).slice(0, 40)}`;
        this.db.prepare("INSERT INTO work_approvals (id, obligation_id, approval_key, prompt, status, requested_by, decided_by, decided_at, payload_json, payload_hash, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, ?, ?)").run(
          approvalId,
          id,
          key,
          input.approval.prompt.trim(),
          input.approval.requestedBy?.trim() ?? null,
          jsonText(input.approval.payload),
          input.approval.payload === undefined ? null : hash(canonicalJson(input.approval.payload)),
          now,
          now,
        );
      }
      if (input.evidence) {
        const kind = input.evidence.kind.trim();
        const reference = input.evidence.reference.trim();
        const evidenceId = `omb_evidence_${hash(`${id}\u001f${kind}\u001f${reference}`).slice(0, 40)}`;
        this.db.prepare("INSERT INTO work_evidence (id, obligation_id, kind, reference, summary, recorded_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          evidenceId,
          id,
          kind,
          reference,
          input.evidence.summary.trim(),
          input.evidence.recordedAt ?? now,
          jsonText(input.evidence.metadata),
        );
      }
      return { status: "created", obligation: this.obligationById(id) };
    });
  }

  getObligation(id: string): WorkObligation | null {
    const row = this.db.prepare("SELECT * FROM work_obligations WHERE id = ?").get(id);
    if (row === undefined) return null;
    return this.obligationFromRow(obligationRowSchema.parse(row));
  }

  updateObligation(id: string, raw: UpdateObligationInput): WorkObligation {
    const input = updateInputSchema.parse(raw);
    return this.transaction(() => {
      const current = this.requireObligation(id);
      this.assertMutable(current);
      this.assertVersion(current, input.expectedVersion);
      const sets: string[] = [];
      const values: Array<string | number | null> = [];
      if (input.title !== undefined) { sets.push("title = ?"); values.push(input.title.trim()); }
      if (input.description !== undefined) { sets.push("description = ?"); values.push(input.description); }
      if (input.ownerId !== undefined) { sets.push("owner_id = ?"); values.push(input.ownerId); }
      if (input.ownerLabel !== undefined) { sets.push("owner_label = ?"); values.push(input.ownerLabel.trim() || null); }
      if (input.metadata !== undefined) { sets.push("metadata_json = ?"); values.push(jsonText(input.metadata)); }
      if (sets.length === 0) return current;
      const now = this.now();
      sets.push("version = version + 1", "updated_at = ?");
      values.push(now, id);
      this.db.prepare(`UPDATE work_obligations SET ${sets.join(", ")} WHERE id = ? AND version = ?`).run(...values, current.version);
      return this.obligationById(id);
    });
  }

  transitionObligation(id: string, status: WorkObligationStatus, expectedVersion?: number): WorkObligation {
    if (!WORK_OBLIGATION_STATUSES.includes(status)) throw new WorkLockError("invalid", `Unknown obligation status: ${status}`);
    return this.transaction(() => {
      const current = this.requireObligation(id);
      this.assertVersion(current, expectedVersion);
      if (current.status === status) return current;
      this.assertMutable(current);
      const allowedTransitions: readonly WorkObligationStatus[] = legalObligationTransitions[current.status];
      if (!allowedTransitions.includes(status)) throw new WorkLockError("illegal_transition", `Cannot transition obligation from ${current.status} to ${status}`);
      if (status === "completed" && current.approvals.some((approval) => approval.status === "pending")) throw new WorkLockError("approval_pending", "Resolve pending approvals before completing this obligation");
      if (status === "completed" && current.evidence.length === 0) throw new WorkLockError("evidence_required", "Record completion evidence before completing this obligation");
      const now = this.now();
      const completedAt = status === "completed" ? now : null;
      const cancelledAt = status === "cancelled" ? now : null;
      this.db.prepare("UPDATE work_obligations SET status = ?, version = version + 1, updated_at = ?, completed_at = ?, cancelled_at = ? WHERE id = ? AND version = ?").run(status, now, completedAt, cancelledAt, id, current.version);
      return this.obligationById(id);
    });
  }

  completeObligation(id: string, expectedVersion?: number): WorkObligation { return this.transitionObligation(id, "completed", expectedVersion); }
  cancelObligation(id: string, expectedVersion?: number): WorkObligation { return this.transitionObligation(id, "cancelled", expectedVersion); }

  setOwner(id: string, owner: WorkOwner | null, expectedVersion?: number): WorkObligation {
    if (owner && (!owner.id.trim() || owner.id.length > 300)) throw new WorkLockError("invalid", "Owner id must be non-empty and bounded");
    const update: UpdateObligationInput = { expectedVersion, ownerId: owner?.id.trim() ?? null };
    if (owner?.label !== undefined) update.ownerLabel = owner.label;
    return this.updateObligation(id, update);
  }

  addApproval(id: string, raw: AddApprovalInput, expectedVersion?: number): { status: "created" | "deduplicated"; approval: WorkApproval; obligation: WorkObligation } {
    const input = approvalInputSchema.parse(raw);
    return this.transaction(() => {
      const current = this.requireObligation(id);
      this.assertMutable(current);
      this.assertVersion(current, expectedVersion);
      const key = normalized(input.key);
      const existing = this.db.prepare("SELECT * FROM work_approvals WHERE obligation_id = ? AND approval_key = ?").get(id, key);
      if (existing !== undefined) {
        return { status: "deduplicated", approval: this.approvalFromRow(approvalRowSchema.parse(existing)), obligation: current };
      }
      const now = this.now();
      const approvalId = `omb_approval_${hash(`${id}\u001f${key}`).slice(0, 40)}`;
      this.db.prepare("INSERT INTO work_approvals (id, obligation_id, approval_key, prompt, status, requested_by, decided_by, decided_at, payload_json, payload_hash, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, ?, ?)").run(
        approvalId, id, key, input.prompt.trim(), input.requestedBy?.trim() ?? null, jsonText(input.payload), input.payload === undefined ? null : hash(canonicalJson(input.payload)), now, now,
      );
      const obligation = this.bumpObligation(current);
      return { status: "created", approval: this.approvalById(approvalId), obligation };
    });
  }

  decideApproval(id: string, approvalId: string, status: "approved" | "rejected" | "revoked", decidedBy?: string, expectedVersion?: number): { approval: WorkApproval; obligation: WorkObligation } {
    return this.transaction(() => {
      const current = this.requireObligation(id);
      this.assertMutable(current);
      this.assertVersion(current, expectedVersion);
      const approval = this.approvalById(approvalId);
      if (approval.obligationId !== id) throw new WorkLockError("not_found", `Approval not found for obligation: ${approvalId}`);
      if (status === "revoked" && approval.status !== "approved" && approval.status !== "pending") throw new WorkLockError("illegal_transition", `Cannot revoke an approval already ${approval.status}`);
      if (status !== "revoked" && approval.status !== "pending") throw new WorkLockError("illegal_transition", `Cannot decide an approval already ${approval.status}`);
      const now = this.now();
      this.db.prepare("UPDATE work_approvals SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?").run(status, decidedBy?.trim() ?? null, now, now, approvalId);
      const obligation = this.bumpObligation(current);
      return { approval: this.approvalById(approvalId), obligation };
    });
  }

  addDeadline(id: string, raw: AddDeadlineInput, expectedVersion?: number): { status: "created" | "deduplicated"; deadline: WorkDeadline; obligation: WorkObligation } {
    const input = deadlineInputSchema.parse(raw);
    return this.transaction(() => {
      const current = this.requireObligation(id);
      this.assertMutable(current);
      this.assertVersion(current, expectedVersion);
      const key = normalized(input.key ?? `deadline-${hash(`${input.label}\u001f${input.dueAt}`).slice(0, 16)}`);
      const existing = this.db.prepare("SELECT * FROM work_deadlines WHERE obligation_id = ? AND deadline_key = ?").get(id, key);
      if (existing !== undefined) return { status: "deduplicated", deadline: this.deadlineFromRow(deadlineRowSchema.parse(existing)), obligation: current };
      const now = this.now();
      const deadlineId = `omb_deadline_${hash(`${id}\u001f${key}`).slice(0, 40)}`;
      this.db.prepare("INSERT INTO work_deadlines (id, obligation_id, deadline_key, label, due_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)").run(deadlineId, id, key, input.label.trim(), input.dueAt, now, now);
      const obligation = this.bumpObligation(current);
      return { status: "created", deadline: this.deadlineById(deadlineId), obligation };
    });
  }

  decideDeadline(id: string, deadlineId: string, status: "met" | "missed" | "cancelled", expectedVersion?: number): { deadline: WorkDeadline; obligation: WorkObligation } {
    return this.transaction(() => {
      const current = this.requireObligation(id);
      this.assertMutable(current);
      this.assertVersion(current, expectedVersion);
      const deadline = this.deadlineById(deadlineId);
      if (deadline.obligationId !== id) throw new WorkLockError("not_found", `Deadline not found for obligation: ${deadlineId}`);
      if (deadline.status !== "active") throw new WorkLockError("illegal_transition", `Cannot decide a deadline already ${deadline.status}`);
      const now = this.now();
      this.db.prepare("UPDATE work_deadlines SET status = ?, updated_at = ? WHERE id = ?").run(status, now, deadlineId);
      const obligation = this.bumpObligation(current);
      return { deadline: this.deadlineById(deadlineId), obligation };
    });
  }

  recordEvidence(id: string, raw: AddEvidenceInput, expectedVersion?: number): { status: "recorded" | "deduplicated"; evidence: WorkEvidence; obligation: WorkObligation } {
    const input = evidenceInputSchema.parse(raw);
    return this.transaction(() => {
      const current = this.requireObligation(id);
      this.assertMutable(current);
      this.assertVersion(current, expectedVersion);
      const existing = this.db.prepare("SELECT * FROM work_evidence WHERE obligation_id = ? AND kind = ? AND reference = ?").get(id, input.kind.trim(), input.reference.trim());
      if (existing !== undefined) return { status: "deduplicated", evidence: this.evidenceFromRow(evidenceRowSchema.parse(existing)), obligation: current };
      const recordedAt = input.recordedAt ?? this.now();
      const evidenceId = `omb_evidence_${hash(`${id}\u001f${input.kind.trim()}\u001f${input.reference.trim()}`).slice(0, 40)}`;
      this.db.prepare("INSERT INTO work_evidence (id, obligation_id, kind, reference, summary, recorded_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(evidenceId, id, input.kind.trim(), input.reference.trim(), input.summary.trim(), recordedAt, jsonText(input.metadata));
      const obligation = this.bumpObligation(current);
      return { status: "recorded", evidence: this.evidenceById(evidenceId), obligation };
    });
  }

  listOpenWork(query: OpenWorkQuery = {}): OpenWorkProjection {
    const statuses = query.statuses ?? ["open", "in_progress", "blocked"];
    const asOf = query.asOf ?? this.now();
    if (statuses.length === 0) return { generatedAt: asOf, obligations: [], pendingApprovals: [], deadlines: [] };
    const limit = Math.max(1, Math.min(query.limit ?? 200, 1_000));
    const values: Array<string | number> = [];
    const clauses = [`status IN (${statuses.map(() => "?").join(",")})`];
    values.push(...statuses);
    if (query.ownerId !== undefined) { clauses.push("owner_id = ?"); values.push(query.ownerId); }
    values.push(limit);
    const rows = this.db.prepare(`SELECT * FROM work_obligations WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id ASC LIMIT ?`).all(...values);
    const obligations = rows.map((row) => {
      const obligation = this.obligationFromRow(obligationRowSchema.parse(row));
      return {
        ...obligation,
        approvals: obligation.approvals.map((approval) => ({ ...approval, payload: null })),
      };
    });
    const pendingApprovals = obligations.flatMap((obligation) => obligation.approvals.filter((approval) => approval.status === "pending"));
    // The projection exposes effective deadline state without mutating the
    // canonical record during a read. A later explicit decision can persist
    // "missed"; until then dueAt remains the durable source of truth.
    const deadlines = obligations.flatMap((obligation) => obligation.deadlines
      .map((deadline) => deadline.status === "active" && deadline.dueAt < asOf ? { ...deadline, status: "missed" as const } : deadline)
      .filter((deadline) => deadline.status === "active" || deadline.status === "missed"));
    return { generatedAt: asOf, obligations, pendingApprovals, deadlines };
  }

  close(): void { this.db.close(); }

  private identity(input: z.infer<typeof createInputSchema>): WorkExternalIdentity {
    if (input.externalIdentity) return { source: normalized(input.externalIdentity.source), id: normalized(input.externalIdentity.id) };
    if (input.source && input.externalId) return { source: normalized(input.source), id: normalized(input.externalId) };
    if (input.externalKey) return { source: normalized(input.source ?? "external"), id: normalized(input.externalKey) };
    return { source: "local", id: randomUUID() };
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* preserve the original error */ } throw error; }
  }

  private assertVersion(obligation: WorkObligation, expectedVersion: number | undefined): void {
    if (expectedVersion !== undefined && obligation.version !== expectedVersion) throw new WorkLockError("version_conflict", `Obligation ${obligation.id} is at version ${obligation.version}; expected ${expectedVersion}`);
  }

  private assertMutable(obligation: WorkObligation): void {
    if (obligation.status === "completed" || obligation.status === "cancelled") {
      throw new WorkLockError("illegal_transition", `Cannot mutate a ${obligation.status} obligation`);
    }
  }

  private bumpObligation(obligation: WorkObligation): WorkObligation {
    const now = this.now();
    this.db.prepare("UPDATE work_obligations SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(now, obligation.id, obligation.version);
    return this.obligationById(obligation.id);
  }

  private requireObligation(id: string): WorkObligation {
    const obligation = this.getObligation(id);
    if (!obligation) throw new WorkLockError("not_found", `Obligation not found: ${id}`);
    return obligation;
  }

  private obligationById(id: string): WorkObligation {
    const obligation = this.getObligation(id);
    if (!obligation) throw new WorkLockError("not_found", `Obligation not found: ${id}`);
    return obligation;
  }

  private obligationFromRow(row: z.infer<typeof obligationRowSchema>): WorkObligation {
    const owner: WorkOwner | null = row.owner_id === null ? null : { id: row.owner_id };
    if (owner && row.owner_label !== null) owner.label = row.owner_label;
    return {
      id: row.id,
      externalIdentity: { source: row.external_namespace, id: row.external_key },
      title: row.title,
      description: row.description,
      status: row.status,
      owner,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
      metadata: row.metadata_json === null ? null : parseJson(row.metadata_json),
      approvals: this.approvalsFor(row.id),
      deadlines: this.deadlinesFor(row.id),
      evidence: this.evidenceFor(row.id),
    };
  }

  private approvalFromRow(row: z.infer<typeof approvalRowSchema>): WorkApproval {
    return { id: row.id, obligationId: row.obligation_id, key: row.approval_key, prompt: row.prompt, status: row.status, requestedBy: row.requested_by, decidedBy: row.decided_by, decidedAt: row.decided_at, payload: row.payload_json === null ? null : parseJson(row.payload_json), payloadHash: row.payload_hash, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private deadlineFromRow(row: z.infer<typeof deadlineRowSchema>): WorkDeadline {
    return { id: row.id, obligationId: row.obligation_id, key: row.deadline_key, label: row.label, dueAt: row.due_at, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private evidenceFromRow(row: z.infer<typeof evidenceRowSchema>): WorkEvidence {
    return { id: row.id, obligationId: row.obligation_id, kind: row.kind, reference: row.reference, summary: row.summary, recordedAt: row.recorded_at, metadata: row.metadata_json === null ? null : parseJson(row.metadata_json) };
  }

  private approvalById(id: string): WorkApproval {
    const row = this.db.prepare("SELECT * FROM work_approvals WHERE id = ?").get(id);
    if (row === undefined) throw new WorkLockError("not_found", `Approval not found: ${id}`);
    return this.approvalFromRow(approvalRowSchema.parse(row));
  }

  private deadlineById(id: string): WorkDeadline {
    const row = this.db.prepare("SELECT * FROM work_deadlines WHERE id = ?").get(id);
    if (row === undefined) throw new WorkLockError("not_found", `Deadline not found: ${id}`);
    return this.deadlineFromRow(deadlineRowSchema.parse(row));
  }

  private evidenceById(id: string): WorkEvidence {
    const row = this.db.prepare("SELECT * FROM work_evidence WHERE id = ?").get(id);
    if (row === undefined) throw new WorkLockError("not_found", `Evidence not found: ${id}`);
    return this.evidenceFromRow(evidenceRowSchema.parse(row));
  }

  private approvalsFor(id: string): WorkApproval[] { return this.db.prepare("SELECT * FROM work_approvals WHERE obligation_id = ? ORDER BY created_at ASC, id ASC").all(id).map((row) => this.approvalFromRow(approvalRowSchema.parse(row))); }
  private deadlinesFor(id: string): WorkDeadline[] { return this.db.prepare("SELECT * FROM work_deadlines WHERE obligation_id = ? ORDER BY due_at ASC, id ASC").all(id).map((row) => this.deadlineFromRow(deadlineRowSchema.parse(row))); }
  private evidenceFor(id: string): WorkEvidence[] { return this.db.prepare("SELECT * FROM work_evidence WHERE obligation_id = ? ORDER BY recorded_at ASC, id ASC").all(id).map((row) => this.evidenceFromRow(evidenceRowSchema.parse(row))); }
}

export function createWorkLockStore(options: { file?: string; now?: () => number } = {}): WorkLockStoreInterface {
  return new WorkLockStore(options);
}

