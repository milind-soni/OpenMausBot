import { z } from "zod";
import type { JsonValue } from "../../server/schema.ts";

export const WORK_OBLIGATION_STATUSES = ["open", "in_progress", "blocked", "completed", "cancelled"] as const;
export type WorkObligationStatus = (typeof WORK_OBLIGATION_STATUSES)[number];

export const WORK_APPROVAL_STATUSES = ["pending", "approved", "rejected", "revoked"] as const;
export type WorkApprovalStatus = (typeof WORK_APPROVAL_STATUSES)[number];

export const WORK_DEADLINE_STATUSES = ["active", "met", "missed", "cancelled"] as const;
export type WorkDeadlineStatus = (typeof WORK_DEADLINE_STATUSES)[number];

export interface WorkOwner {
  id: string;
  label?: string;
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
  /** The projection deliberately redacts this value. */
  payload: unknown | null;
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

export interface WorkEvidence {
  id: string;
  obligationId: string;
  kind: string;
  reference: string;
  summary: string;
  recordedAt: number;
  metadata: unknown | null;
}

export interface WorkObligation {
  id: string;
  externalIdentity: { source: string; id: string };
  title: string;
  description: string | null;
  status: WorkObligationStatus;
  owner: WorkOwner | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  cancelledAt: number | null;
  metadata: unknown | null;
  approvals: WorkApproval[];
  deadlines: WorkDeadline[];
  evidence: WorkEvidence[];
}

export interface WorkProjection {
  generatedAt: number;
  obligations: WorkObligation[];
  pendingApprovals: WorkApproval[];
  deadlines: WorkDeadline[];
}

export interface WorkSections {
  approvals: WorkApproval[];
  openLocks: WorkObligation[];
  activeWork: WorkObligation[];
  completed: WorkObligation[];
}

export const EMPTY_WORK_PROJECTION: WorkProjection = { generatedAt: 0, obligations: [], pendingApprovals: [], deadlines: [] };

const ownerSchema = z.object({ id: z.string(), label: z.string().optional() });
const approvalSchema = z.object({ id: z.string(), obligationId: z.string().optional(), key: z.string().default(""), prompt: z.string().default("Approval requested"), status: z.enum(WORK_APPROVAL_STATUSES).catch("pending"), requestedBy: z.string().nullable().optional(), decidedBy: z.string().nullable().optional(), decidedAt: z.number().finite().nullable().optional(), payload: z.unknown().nullable().optional(), payloadHash: z.string().nullable().optional(), createdAt: z.number().finite().default(0), updatedAt: z.number().finite().default(0) }).passthrough();
const deadlineSchema = z.object({ id: z.string(), obligationId: z.string().optional(), key: z.string().default(""), label: z.string().default("Deadline"), dueAt: z.number().finite().default(0), status: z.enum(WORK_DEADLINE_STATUSES).catch("active"), createdAt: z.number().finite().default(0), updatedAt: z.number().finite().default(0) }).passthrough();
const evidenceSchema = z.object({ id: z.string(), obligationId: z.string().optional(), kind: z.string().default("evidence"), reference: z.string().default(""), summary: z.string().default(""), recordedAt: z.number().finite().default(0), metadata: z.unknown().nullable().optional() }).passthrough();
const identitySchema = z.object({ source: z.string().default("local"), id: z.string().default("") });
const obligationSchema = z.object({ id: z.string(), externalIdentity: identitySchema.optional(), title: z.string().default("Untitled work"), description: z.string().nullable().optional(), status: z.enum(WORK_OBLIGATION_STATUSES).catch("open"), owner: ownerSchema.nullable().optional(), version: z.number().finite().default(0), createdAt: z.number().finite().default(0), updatedAt: z.number().finite().default(0), completedAt: z.number().finite().nullable().optional(), cancelledAt: z.number().finite().nullable().optional(), metadata: z.unknown().nullable().optional(), approvals: z.array(approvalSchema).default([]), deadlines: z.array(deadlineSchema).default([]), evidence: z.array(evidenceSchema).default([]) }).passthrough();
const projectionSchema = z.object({ generatedAt: z.number().finite().default(0), obligations: z.array(obligationSchema).default([]), pendingApprovals: z.array(approvalSchema).default([]), deadlines: z.array(deadlineSchema).default([]) });
const envelopeSchema = z.union([z.object({ work: projectionSchema }), projectionSchema]);

function normalizeApproval(value: z.infer<typeof approvalSchema>, obligationId: string): WorkApproval { return { id: value.id, obligationId: value.obligationId ?? obligationId, key: value.key, prompt: value.prompt, status: value.status, requestedBy: value.requestedBy ?? null, decidedBy: value.decidedBy ?? null, decidedAt: value.decidedAt ?? null, payload: null, payloadHash: value.payloadHash ?? null, createdAt: value.createdAt, updatedAt: value.updatedAt }; }
function normalizeDeadline(value: z.infer<typeof deadlineSchema>, obligationId: string): WorkDeadline { return { id: value.id, obligationId: value.obligationId ?? obligationId, key: value.key, label: value.label, dueAt: value.dueAt, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt }; }
function normalizeEvidence(value: z.infer<typeof evidenceSchema>, obligationId: string): WorkEvidence { return { id: value.id, obligationId: value.obligationId ?? obligationId, kind: value.kind, reference: value.reference, summary: value.summary, recordedAt: value.recordedAt, metadata: value.metadata ?? null }; }
function normalizeObligation(value: z.infer<typeof obligationSchema>): WorkObligation {
  const obligationId = value.id;
  return { id: obligationId, externalIdentity: value.externalIdentity ? { source: value.externalIdentity.source, id: value.externalIdentity.id || obligationId } : { source: "local", id: obligationId }, title: value.title, description: value.description ?? null, status: value.status, owner: value.owner ?? null, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt, completedAt: value.completedAt ?? null, cancelledAt: value.cancelledAt ?? null, metadata: value.metadata ?? null, approvals: value.approvals.map((approval) => normalizeApproval(approval, obligationId)), deadlines: value.deadlines.map((deadline) => normalizeDeadline(deadline, obligationId)), evidence: value.evidence.map((evidence) => normalizeEvidence(evidence, obligationId)) };
}

/** Validate and normalize JSON at the API boundary. Invalid envelopes return an empty view. */
export function parseWorkProjection(value: JsonValue): WorkProjection {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return EMPTY_WORK_PROJECTION;
  const projection = "work" in parsed.data ? parsed.data.work : parsed.data;
  const obligations = projection.obligations.map(normalizeObligation);
  const approvalsById = new Map<string, WorkApproval>();
  for (const approval of obligations.flatMap((obligation) => obligation.approvals)) if (approval.status === "pending") approvalsById.set(approval.id, approval);
  for (const approval of projection.pendingApprovals) { const normalized = normalizeApproval(approval, approval.obligationId ?? ""); if (normalized.status === "pending") approvalsById.set(normalized.id, normalized); }
  return {
    generatedAt: projection.generatedAt,
    obligations,
    pendingApprovals: [...approvalsById.values()],
    deadlines: projection.deadlines.map((deadline) => normalizeDeadline(deadline, deadline.obligationId ?? "")),
  };
}

export function workSections(projection: WorkProjection): WorkSections {
  return {
    approvals: projection.pendingApprovals,
    openLocks: projection.obligations.filter((obligation) => obligation.status === "open" || obligation.status === "blocked"),
    activeWork: projection.obligations.filter((obligation) => obligation.status === "in_progress"),
    completed: projection.obligations.filter((obligation) => obligation.status === "completed"),
  };
}

export function workStatusLabel(status: WorkObligationStatus): string {
  switch (status) {
    case "open": return "Open";
    case "in_progress": return "In progress";
    case "blocked": return "Blocked";
    case "completed": return "Completed";
    case "cancelled": return "Cancelled";
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}
