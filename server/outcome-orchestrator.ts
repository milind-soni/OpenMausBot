import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";
import type { JsonObject } from "./schema.ts";
import {
  buildOutcomeRecord,
  isOutcomeRecord,
  redactEvidenceReference,
  traceIdentity,
  type ExecutionTraceEntry,
  type OutcomeLearning,
  type OutcomeRecord,
} from "./execution-learning.ts";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns,
 * anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type,
 * anti-slop/no-known-value-widening -- existing WorkOrchestrator and verifier
 * seams are intentionally unknown here; values are parsed before use. */

/** The V2 WorkOrchestrator seam. Outcome Mode consumes this interface; it does
 * not add methods to it or create a second work lifecycle. */
export interface ExistingWorkOrchestrator {
  ingest(event: unknown): unknown;
  prepare(workId: string): unknown;
  decide(input: unknown): unknown;
  execute(workId: string): Promise<unknown>;
  reconcile(workId: string): Promise<unknown>;
}

export interface OutcomeVerifier {
  verify(input: OutcomeVerificationInput): Promise<unknown>;
}

export interface CaptureOutcomeInference {
  infer(input: CaptureInferenceInput): Promise<unknown>;
}

export interface ContractualJudgment {
  judge(input: ContractualJudgmentInput): Promise<unknown>;
}

export type CaptureInferenceInput = {
  readonly evidence: CaptureEvidence;
  readonly existingOutcomes: readonly OutcomeIdentity[];
};

export type OutcomeIdentity = {
  readonly outcomeId: string;
  readonly contractVersion: number;
  readonly objective: string;
  readonly state: OutcomeView["state"];
};

export type ContractualJudgmentInput = {
  readonly contract: OutcomeContract;
  readonly workIds: readonly string[];
  readonly evidence: readonly OutcomeEvidence[];
};

export type OutcomeJudgment =
  | { readonly color: "green" }
  | { readonly color: "yellow"; readonly input: NeedsYouInput }
  | { readonly color: "red"; readonly reason: string };

export type OutcomeCommand =
  | { readonly kind: "declare"; readonly contract: OutcomeContract }
  | { readonly kind: "capture"; readonly evidence: CaptureEvidence }
  | { readonly kind: "accept"; readonly outcomeId: string; readonly contractVersion: number }
  | { readonly kind: "run"; readonly outcomeId: string; readonly contractVersion: number }
  | { readonly kind: "answer-needs-you"; readonly outcomeId: string; readonly contractVersion: number; readonly inputKey: string; readonly answer: string; readonly answeredBy: string }
  | { readonly kind: "record-evidence"; readonly evidence: OutcomeEvidence }
  | { readonly kind: "verify"; readonly outcomeId: string; readonly contractVersion: number }
  | { readonly kind: "cancel"; readonly outcomeId: string; readonly contractVersion: number; readonly reason: string };

export type OutcomeContract = z.infer<typeof contractSchema>;
export type CaptureEvidence = z.infer<typeof captureEvidenceSchema>;
export type OutcomeEvidence = z.infer<typeof evidenceSchema>;
export type OutcomeArtifact = z.infer<typeof artifactSchema>;
export type WorkLink = z.infer<typeof workLinkSchema>;
export type NeedsYouInput = z.infer<typeof needsYouSchema>;
export type OutcomeReceipt = z.infer<typeof receiptSchema>;
export type OutcomeVerificationInput = {
  readonly contract: OutcomeContract;
  readonly workIds: readonly string[];
  readonly evidence: readonly OutcomeEvidence[];
  readonly artifacts: readonly OutcomeArtifact[];
  readonly criteriaHash: string;
  readonly traceIdentity: string;
};

export type CaptureContextDelta = {
  readonly nodes: readonly {
    readonly id: string;
    readonly type: "capture" | "outcome" | "verified-outcome" | "receipt" | "learning" | "entity" | "relationship" | "constraint" | "dependency";
    readonly provenance?: { readonly source: string; readonly reference: string; readonly contentHash: string; readonly observedAt: number };
    readonly contractId?: string;
    readonly contractVersion?: number;
    readonly receiptReference?: string;
  }[];
  readonly edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly kind: "supports" | "related-to" | "conflicts" | "depends-on" | "produced-by" | "learned-from";
  }[];
};

export type OutcomeView =
  | { readonly state: "declared"; readonly contract: OutcomeContract; readonly work: readonly WorkLink[]; readonly evidence: readonly OutcomeEvidence[]; readonly needsYou: null; readonly judgment: OutcomeJudgment | null; readonly receipt: null }
  | { readonly state: "accepted"; readonly contract: OutcomeContract; readonly work: readonly WorkLink[]; readonly evidence: readonly OutcomeEvidence[]; readonly needsYou: null; readonly judgment: OutcomeJudgment | null; readonly receipt: null }
  | { readonly state: "running"; readonly contract: OutcomeContract; readonly work: readonly WorkLink[]; readonly evidence: readonly OutcomeEvidence[]; readonly needsYou: null; readonly judgment: OutcomeJudgment | null; readonly receipt: null }
  | { readonly state: "needs-you"; readonly contract: OutcomeContract; readonly work: readonly WorkLink[]; readonly evidence: readonly OutcomeEvidence[]; readonly needsYou: NeedsYouInput; readonly judgment: OutcomeJudgment | null; readonly receipt: null }
  | { readonly state: "verifying"; readonly contract: OutcomeContract; readonly work: readonly WorkLink[]; readonly evidence: readonly OutcomeEvidence[]; readonly needsYou: null; readonly judgment: OutcomeJudgment | null; readonly receipt: null }
  | { readonly state: "completed"; readonly contract: OutcomeContract; readonly work: readonly WorkLink[]; readonly evidence: readonly OutcomeEvidence[]; readonly needsYou: null; readonly judgment: OutcomeJudgment | null; readonly receipt: OutcomeReceipt }
  | { readonly state: "failed" | "cancelled" | "rolled_back"; readonly contract: OutcomeContract; readonly work: readonly WorkLink[]; readonly evidence: readonly OutcomeEvidence[]; readonly needsYou: null; readonly judgment: OutcomeJudgment | null; readonly receipt: null; readonly reason: string };

export type OutcomeCommandResult =
  | { readonly status: "ok"; readonly view: OutcomeView; readonly receipt?: OutcomeReceipt }
  | { readonly status: "needs_you"; readonly view: Extract<OutcomeView, { state: "needs-you" }>; readonly input: NeedsYouInput }
  | { readonly status: "blocked"; readonly view?: OutcomeView; readonly reason: string }
  | { readonly status: "denied"; readonly reason: string; readonly view?: OutcomeView }
  | { readonly status: "unavailable"; readonly reason: "journal_unavailable" | "journal_write_failed" };

export type OutcomeInspection =
  | { readonly status: "available"; readonly view: OutcomeView }
  | { readonly status: "missing" }
  | { readonly status: "unavailable" };

export interface OutcomeOrchestrator {
  dispatch(command: unknown): Promise<OutcomeCommandResult>;
  inspect(outcomeId: string): OutcomeInspection;
}

export interface OutcomeProjection {
  readonly outcomeId: string;
  readonly title: string;
  readonly state: OutcomeView["state"];
  readonly quiet: true;
  readonly work: readonly { readonly workId: string; readonly label: string; readonly state: WorkLink["status"] }[];
  readonly chatSummary: string;
}

export interface OutcomeOrchestratorOptions {
  readonly journalFile: string;
  readonly work: ExistingWorkOrchestrator;
  readonly verifier: OutcomeVerifier;
  readonly captureInference?: CaptureOutcomeInference;
  readonly judgment?: ContractualJudgment;
  readonly learning?: OutcomeLearning;
  readonly now?: () => number;
}

const grantSchema = z.object({
  action: z.string().trim().min(1).max(200),
  target: z.string().trim().min(1).max(500),
  scope: z.string().trim().min(1).max(500),
  expiresAt: z.number().finite().nonnegative(),
}).strict();

const constraintSchema = z.object({
  kind: z.enum(["time", "budget", "scope", "quality", "privacy", "authority"]),
  statement: z.string().trim().min(1).max(2_000),
}).strict();

const criterionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  statement: z.string().trim().min(1).max(2_000),
}).strict();

const needsYouSchema = z.object({
  inputKey: z.string().trim().min(1).max(120),
  question: z.string().trim().min(1).max(2_000),
  choices: z.array(z.string().trim().min(1).max(300)).max(5),
}).strict();

const taskSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(25_000),
  resumePolicy: z.enum(["safe", "never"]),
  dependsOn: z.array(z.string().trim().min(1).max(120)).max(8),
  needsYou: needsYouSchema.nullable(),
  requiredAuthority: grantSchema.nullable(),
  estimatedCostCents: z.number().int().nonnegative().finite(),
  estimatedUnits: z.number().int().nonnegative().finite(),
}).strict();

const contractSchema = z.object({
  id: z.string().trim().min(1).max(200),
  outcomeId: z.string().trim().min(1).max(200),
  version: z.number().int().positive(),
  ownerId: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(4_000),
  constraints: z.array(constraintSchema).max(30),
  successCriteria: z.array(criterionSchema).min(1).max(30),
  deadline: z.object({ at: z.number().finite().nonnegative() }).strict(),
  budget: z.object({ currency: z.literal("USD"), maxCostCents: z.number().int().nonnegative().finite(), maxUnits: z.number().int().nonnegative().finite() }).strict(),
  qualityBar: z.string().trim().min(1).max(2_000),
  authority: z.object({ mode: z.literal("deny-by-default"), grants: z.array(grantSchema).max(30) }).strict(),
  escalation: z.object({ channel: z.literal("needs-you"), on: z.array(z.enum(["missing-input", "deadline-risk", "budget-risk", "quality-risk", "authority-required"])).min(1).max(10) }).strict(),
  evidenceRequirements: z.object({ requiredCriterionIds: z.array(z.string().trim().min(1).max(100)).min(1).max(30), requiredArtifactKinds: z.array(z.string().trim().min(1).max(100)).max(20) }).strict(),
  rollback: z.object({ onCancel: z.enum(["stop", "reversible-stop"]), onFailure: z.enum(["stop", "reversible-stop"]) }).strict(),
  plan: z.array(taskSchema).min(1).max(30),
}).strict();

const artifactSchema = z.object({
  reference: z.string().trim().min(1).max(2_000),
  kind: z.string().trim().min(1).max(100),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();

const contextNodeSchema = z.object({
  id: z.string().trim().min(1).max(300),
  type: z.enum(["capture", "outcome", "verified-outcome", "receipt", "learning", "entity", "relationship", "constraint", "dependency"]),
  provenance: z.object({ source: z.string().trim().min(1).max(200), reference: z.string().trim().min(1).max(2_000), contentHash: z.string().regex(/^[a-f0-9]{64}$/i), observedAt: z.number().finite().nonnegative() }).strict().optional(),
  contractId: z.string().trim().min(1).max(200).optional(),
  contractVersion: z.number().int().positive().optional(),
  receiptReference: z.string().trim().min(1).max(2_000).optional(),
}).strict();

const contextEdgeSchema = z.object({
  from: z.string().trim().min(1).max(300),
  to: z.string().trim().min(1).max(300),
  kind: z.enum(["supports", "related-to", "conflicts", "depends-on", "produced-by", "learned-from"]),
}).strict();

const contextDeltaSchema = z.object({ nodes: z.array(contextNodeSchema).max(200), edges: z.array(contextEdgeSchema).max(500) }).strict();

const captureEvidenceSchema = z.object({
  captureId: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(200),
  reference: z.string().trim().min(1).max(2_000),
  summary: z.string().trim().min(1).max(4_000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  confidence: z.enum(["high", "medium", "low"]),
  criterionIds: z.array(z.string().trim().min(1).max(100)).min(1).max(30),
  artifacts: z.array(artifactSchema).max(20),
  observedAt: z.number().finite().nonnegative(),
  contextDelta: contextDeltaSchema.optional(),
}).strict();

const evidenceSchema = z.object({
  outcomeId: z.string().trim().min(1).max(200),
  contractVersion: z.number().int().positive(),
  evidenceId: z.string().trim().min(1).max(200),
  reference: z.string().trim().min(1).max(2_000),
  summary: z.string().trim().min(1).max(4_000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  criterionIds: z.array(z.string().trim().min(1).max(100)).min(1).max(30),
  artifacts: z.array(artifactSchema).max(20),
  recordedAt: z.number().finite().nonnegative(),
}).strict();

const judgmentSchema = z.discriminatedUnion("color", [
  z.object({ color: z.literal("green") }).strict(),
  z.object({ color: z.literal("yellow"), input: needsYouSchema }).strict(),
  z.object({ color: z.literal("red"), reason: z.string().trim().min(1).max(2_000) }).strict(),
]);

const inferenceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("inferred"), contract: contractSchema }).strict(),
  z.object({ status: z.literal("existing"), outcomeId: z.string().trim().min(1), contractVersion: z.number().int().positive() }).strict(),
  z.object({ status: z.literal("ambiguous"), reason: z.string().trim().min(1).max(2_000) }).strict(),
]);

const workLinkSchema = z.object({
  taskId: z.string().trim().min(1).max(120),
  workId: z.string().trim().min(1).max(300),
  status: z.enum(["planned", "executing", "verified", "failed", "ambiguous"]),
  route: z.string().trim().min(1).max(120).optional(),
}).strict();

const usageSchema = z.object({ costCents: z.number().int().nonnegative().finite(), units: z.number().int().nonnegative().finite() }).strict();
const receiptSchema = z.object({
  kind: z.literal("outcome-completed"),
  outcomeId: z.string(),
  contractId: z.string(),
  contractVersion: z.number().int().positive(),
  criteriaHash: z.string().regex(/^[a-f0-9]{64}$/i),
  workIds: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
  artifactRefs: z.array(z.string()),
  verifiedAt: z.number().finite().nonnegative(),
  usage: usageSchema,
  record: z.custom<OutcomeRecord>(isOutcomeRecord),
}).strict();

const verificationSchema = z.object({
  status: z.literal("verified"),
  contractId: z.string(),
  contractVersion: z.number().int().positive(),
  criteriaHash: z.string().regex(/^[a-f0-9]{64}$/i),
  traceIdentity: z.string().regex(/^[a-f0-9]{64}$/i),
  evidenceRefs: z.array(z.string()),
  artifactRefs: z.array(z.string()),
  usage: usageSchema,
}).strict();

const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("declare"), contract: contractSchema }).strict(),
  z.object({ kind: z.literal("capture"), evidence: captureEvidenceSchema }).strict(),
  z.object({ kind: z.literal("accept"), outcomeId: z.string().trim().min(1), contractVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("run"), outcomeId: z.string().trim().min(1), contractVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("answer-needs-you"), outcomeId: z.string().trim().min(1), contractVersion: z.number().int().positive(), inputKey: z.string().trim().min(1), answer: z.string().trim().min(1).max(4_000), answeredBy: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("record-evidence"), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal("verify"), outcomeId: z.string().trim().min(1), contractVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("cancel"), outcomeId: z.string().trim().min(1), contractVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(2_000) }).strict(),
]);

export function captureContextDelta(command: unknown): CaptureContextDelta | null {
  const parsed = commandSchema.safeParse(command);
  return parsed.success && parsed.data.kind === "capture" ? parsed.data.evidence.contextDelta ?? null : null;
}

type OutcomeEvent =
  | { readonly type: "declared"; readonly contract: OutcomeContract }
  | { readonly type: "capture-linked"; readonly outcomeId: string; readonly contractVersion: number; readonly capture: CaptureEvidence }
  | { readonly type: "accepted"; readonly outcomeId: string; readonly contractVersion: number }
  | { readonly type: "work-linked"; readonly outcomeId: string; readonly contractVersion: number; readonly link: WorkLink }
  | { readonly type: "started"; readonly outcomeId: string; readonly contractVersion: number }
  | { readonly type: "needs-you-requested"; readonly outcomeId: string; readonly contractVersion: number; readonly input: NeedsYouInput }
  | { readonly type: "needs-you-answered"; readonly outcomeId: string; readonly contractVersion: number; readonly inputKey: string; readonly answerHash: string; readonly answerLength: number; readonly answeredBy: string; readonly answeredAt: number }
  | { readonly type: "judgment-recorded"; readonly outcomeId: string; readonly contractVersion: number; readonly judgment: OutcomeJudgment }
  | { readonly type: "work-execution-started"; readonly outcomeId: string; readonly contractVersion: number; readonly workId: string }
  | { readonly type: "work-verified"; readonly outcomeId: string; readonly contractVersion: number; readonly workId: string }
  | { readonly type: "work-failed"; readonly outcomeId: string; readonly contractVersion: number; readonly workId: string; readonly reason: string }
  | { readonly type: "evidence-recorded"; readonly evidence: OutcomeEvidence }
  | { readonly type: "verification-recorded"; readonly outcomeId: string; readonly contractVersion: number }
  | { readonly type: "terminal"; readonly outcomeId: string; readonly contractVersion: number; readonly state: "completed" | "failed" | "cancelled" | "rolled_back"; readonly reason?: string; readonly receipt?: OutcomeReceipt };

interface StoredEvent {
  readonly seq: number;
  readonly at: number;
  readonly idempotencyKey: string;
  readonly event: OutcomeEvent;
}

type Folded = Map<string, OutcomeView>;
type Journal = { readonly status: "ready"; readonly events: readonly StoredEvent[] } | { readonly status: "unavailable" };
type ActiveOutcomeView = Extract<OutcomeView, { state: "accepted" | "running" | "needs-you" | "verifying" }>;

const storedEventSchema = z.object({ seq: z.number().int().positive(), at: z.number().finite().nonnegative(), idempotencyKey: z.string().min(1), event: z.unknown() }).strict();
function eventSchema(value: unknown): OutcomeEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) return null;
  const type = value.type;
  if (type === "declared") {
    const parsed = z.object({ type: z.literal("declared"), contract: contractSchema }).strict().safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  if (type === "capture-linked") return parseEvent(value, z.object({ type: z.literal("capture-linked"), outcomeId: z.string(), contractVersion: z.number().int().positive(), capture: captureEvidenceSchema }).strict());
  if (type === "accepted") return parseEvent(value, z.object({ type: z.literal("accepted"), outcomeId: z.string(), contractVersion: z.number().int().positive() }).strict());
  if (type === "work-linked") return parseEvent(value, z.object({ type: z.literal("work-linked"), outcomeId: z.string(), contractVersion: z.number().int().positive(), link: workLinkSchema }).strict());
  if (type === "started") return parseEvent(value, z.object({ type: z.literal("started"), outcomeId: z.string(), contractVersion: z.number().int().positive() }).strict());
  if (type === "needs-you-requested") return parseEvent(value, z.object({ type: z.literal("needs-you-requested"), outcomeId: z.string(), contractVersion: z.number().int().positive(), input: needsYouSchema }).strict());
  if (type === "needs-you-answered") return parseEvent(value, z.object({ type: z.literal("needs-you-answered"), outcomeId: z.string(), contractVersion: z.number().int().positive(), inputKey: z.string(), answerHash: z.string().regex(/^[a-f0-9]{64}$/i), answerLength: z.number().int().nonnegative(), answeredBy: z.string(), answeredAt: z.number().finite().nonnegative() }).strict());
  if (type === "judgment-recorded") return parseEvent(value, z.object({ type: z.literal("judgment-recorded"), outcomeId: z.string(), contractVersion: z.number().int().positive(), judgment: judgmentSchema }).strict());
  if (type === "work-execution-started") return parseEvent(value, z.object({ type: z.literal("work-execution-started"), outcomeId: z.string(), contractVersion: z.number().int().positive(), workId: z.string() }).strict());
  if (type === "work-verified") return parseEvent(value, z.object({ type: z.literal("work-verified"), outcomeId: z.string(), contractVersion: z.number().int().positive(), workId: z.string() }).strict());
  if (type === "work-failed") return parseEvent(value, z.object({ type: z.literal("work-failed"), outcomeId: z.string(), contractVersion: z.number().int().positive(), workId: z.string(), reason: z.string() }).strict());
  if (type === "evidence-recorded") return parseEvent(value, z.object({ type: z.literal("evidence-recorded"), evidence: evidenceSchema }).strict());
  if (type === "verification-recorded") return parseEvent(value, z.object({ type: z.literal("verification-recorded"), outcomeId: z.string(), contractVersion: z.number().int().positive() }).strict());
  if (type === "terminal") return parseEvent(value, z.object({ type: z.literal("terminal"), outcomeId: z.string(), contractVersion: z.number().int().positive(), state: z.enum(["completed", "failed", "cancelled", "rolled_back"]), reason: z.string().optional(), receipt: receiptSchema.optional() }).strict());
  return null;
}

function parseEvent<T extends OutcomeEvent>(value: unknown, schema: z.ZodType<T>): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function loadJournal(file: string): Journal {
  if (!existsSync(file)) return { status: "ready", events: [] };
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
    const events: StoredEvent[] = [];
    let expectedSeq = 1;
    const keys = new Set<string>();
    for (const line of lines) {
      const parsed = storedEventSchema.safeParse(JSON.parse(line));
      if (!parsed.success) return { status: "unavailable" };
      const raw = parsed.data;
      const event = eventSchema(raw.event);
      if (!event || raw.seq !== expectedSeq || keys.has(raw.idempotencyKey)) return { status: "unavailable" };
      keys.add(raw.idempotencyKey);
      events.push({ seq: raw.seq, at: raw.at, idempotencyKey: raw.idempotencyKey, event });
      expectedSeq += 1;
    }
    return { status: "ready", events };
  } catch {
    return { status: "unavailable" };
  }
}

function criteriaHash(contract: OutcomeContract): string {
  return createHash("sha256").update(JSON.stringify(contract.successCriteria), "utf8").digest("hex");
}

function terminal(state: OutcomeView["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "rolled_back";
}

function isActiveView(view: OutcomeView): view is ActiveOutcomeView {
  return view.state === "accepted" || view.state === "running" || view.state === "needs-you" || view.state === "verifying";
}

function updateWork(view: ActiveOutcomeView, workId: string, status: WorkLink["status"]): OutcomeView {
  const work = view.work.map((link) => link.workId === workId ? { ...link, status } : link);
  return { ...view, work };
}

function captureAsEvidence(capture: CaptureEvidence, outcomeId: string, contractVersion: number): OutcomeEvidence {
  return {
    outcomeId,
    contractVersion,
    evidenceId: `capture:${capture.captureId}`,
    reference: capture.reference,
    summary: capture.summary,
    contentHash: capture.contentHash,
    criterionIds: capture.criterionIds,
    artifacts: capture.artifacts,
    recordedAt: capture.observedAt,
  };
}

function terminalView(view: OutcomeView, event: Extract<OutcomeEvent, { type: "terminal" }>): OutcomeView {
  if (event.state === "completed") {
    if (!event.receipt) throw new Error("completed outcome requires receipt");
    return { state: "completed", contract: view.contract, work: view.work, evidence: view.evidence, needsYou: null, judgment: view.judgment, receipt: event.receipt };
  }
  return { state: event.state, contract: view.contract, work: view.work, evidence: view.evidence, needsYou: null, judgment: view.judgment, receipt: null, reason: event.reason ?? "" };
}

function traceDetail(value: string): string {
  return value.replace(/\b(password|passwd|secret|token|api[_-]?key|authorization|bearer)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function traceEntry(stored: StoredEvent): ExecutionTraceEntry {
  const event = stored.event;
  switch (event.type) {
    case "declared":
      return { seq: stored.seq, at: stored.at, phase: "intake", action: "contract-declared", refs: [`contract:${event.contract.id}`, `outcome:${event.contract.outcomeId}`].map(redactEvidenceReference), detail: traceDetail(`presumed-outcome=${event.contract.objective}; criteria=${event.contract.successCriteria.map((criterion) => criterion.id).join(",")}; plan=${event.contract.plan.map((task) => task.id).join(",")}`) };
    case "capture-linked":
      return { seq: stored.seq, at: stored.at, phase: "intake", action: "capture-linked", refs: [`capture:${event.capture.captureId}`, event.capture.reference, ...event.capture.artifacts.map((artifact) => artifact.reference)].map(redactEvidenceReference), detail: traceDetail(`source=${event.capture.source}; confidence=${event.capture.confidence}; contentHash=${event.capture.contentHash}`) };
    case "accepted":
      return { seq: stored.seq, at: stored.at, phase: "judgment", action: "contract-accepted", refs: [`contract:${event.outcomeId}:v${event.contractVersion}`].map(redactEvidenceReference) };
    case "work-linked":
      return { seq: stored.seq, at: stored.at, phase: "planning", action: "canonical-work-linked", refs: [event.link.workId, `task:${event.link.taskId}`].map(redactEvidenceReference), detail: `route=${event.link.route ?? "unknown"}; worker=existing-work-orchestrator; model=unknown` };
    case "started":
      return { seq: stored.seq, at: stored.at, phase: "execution", action: "execution-started", refs: [`outcome:${event.outcomeId}:v${event.contractVersion}`].map(redactEvidenceReference) };
    case "needs-you-requested":
      return { seq: stored.seq, at: stored.at, phase: "judgment", action: "needs-you-requested", refs: [`outcome:${event.outcomeId}:v${event.contractVersion}`, `input:${event.input.inputKey}`].map(redactEvidenceReference), detail: traceDetail(event.input.question) };
    case "needs-you-answered":
      return { seq: stored.seq, at: stored.at, phase: "judgment", action: "needs-you-answered", refs: [`outcome:${event.outcomeId}:v${event.contractVersion}`, `input:${event.inputKey}`, `answer:${event.answerHash}`].map(redactEvidenceReference), detail: `answeredBy=${traceDetail(event.answeredBy)}; answerLength=${event.answerLength}` };
    case "judgment-recorded":
      return { seq: stored.seq, at: stored.at, phase: "judgment", action: "contractual-judgment", refs: [`outcome:${event.outcomeId}:v${event.contractVersion}`].map(redactEvidenceReference), detail: traceDetail(event.judgment.color === "red" ? `color=red; reason=${event.judgment.reason}` : event.judgment.color === "yellow" ? `color=yellow; inputKey=${event.judgment.input.inputKey}` : "color=green") };
    case "work-execution-started":
      return { seq: stored.seq, at: stored.at, phase: "execution", action: "work-dispatched", refs: [event.workId, `outcome:${event.outcomeId}:v${event.contractVersion}`].map(redactEvidenceReference), detail: "tool=existing-work-orchestrator.execute; worker=existing-work-orchestrator; model=unknown" };
    case "work-verified":
      return { seq: stored.seq, at: stored.at, phase: "verification", action: "work-reconciled", refs: [event.workId, `outcome:${event.outcomeId}:v${event.contractVersion}`].map(redactEvidenceReference), detail: "worker-receipt=verified" };
    case "work-failed":
      return { seq: stored.seq, at: stored.at, phase: "verification", action: "work-failed", refs: [event.workId, `outcome:${event.outcomeId}:v${event.contractVersion}`].map(redactEvidenceReference), detail: traceDetail(event.reason) };
    case "evidence-recorded":
      return { seq: stored.seq, at: stored.at, phase: "verification", action: "evidence-recorded", refs: [`evidence:${event.evidence.evidenceId}`, event.evidence.reference, ...event.evidence.artifacts.map((artifact) => artifact.reference)].map(redactEvidenceReference), detail: `criteria=${event.evidence.criterionIds.join(",")}; contentHash=${event.evidence.contentHash}` };
    case "verification-recorded":
      return { seq: stored.seq, at: stored.at, phase: "verification", action: "independent-verification-started", refs: [`outcome:${event.outcomeId}:v${event.contractVersion}`].map(redactEvidenceReference), detail: "verifier=independent-verifier" };
    case "terminal":
      return { seq: stored.seq, at: stored.at, phase: "terminal", action: `outcome-${event.state}`, refs: [`outcome:${event.outcomeId}:v${event.contractVersion}`, ...(event.receipt?.record ? [event.receipt.record.recordId, event.receipt.record.links.executionTraceId, event.receipt.record.links.verifiedOutputId, event.receipt.record.links.retrospectiveId] : [])].map(redactEvidenceReference), detail: traceDetail(event.reason ?? "verified-output-persisted") };
    default: {
      const exhaustive: never = event;
      throw new Error(`unknown trace event ${String(exhaustive)}`);
    }
  }
}

function fold(events: readonly StoredEvent[]): Folded {
  const states: Folded = new Map();
  for (const stored of events) {
    const event = stored.event;
    const outcomeId = event.type === "declared"
      ? event.contract.outcomeId
      : event.type === "evidence-recorded"
        ? event.evidence.outcomeId
        : event.outcomeId;
    const current = event.type === "declared" ? undefined : states.get(outcomeId);
    switch (event.type) {
      case "declared":
        if (states.has(event.contract.outcomeId)) throw new Error("duplicate outcome declaration");
        states.set(event.contract.outcomeId, { state: "declared", contract: event.contract, work: [], evidence: [], needsYou: null, judgment: null, receipt: null });
        break;
      case "capture-linked":
        if (!current || terminal(current.state) || current.contract.version !== event.contractVersion) throw new Error("illegal capture link transition");
        if (current.evidence.some((item) => item.evidenceId === `capture:${event.capture.captureId}`)) throw new Error("duplicate capture link");
        states.set(event.outcomeId, { ...current, evidence: [...current.evidence, captureAsEvidence(event.capture, event.outcomeId, event.contractVersion)] });
        break;
      case "accepted":
        if (!current || current.state !== "declared" || current.contract.version !== event.contractVersion) throw new Error("illegal acceptance transition");
        states.set(event.outcomeId, { state: "accepted", contract: current.contract, work: [], evidence: [], needsYou: null, judgment: null, receipt: null });
        break;
      case "work-linked":
        if (!current || !isActiveView(current) || current.contract.version !== event.contractVersion) throw new Error("illegal work link transition");
        if (current.work.some((link) => link.taskId === event.link.taskId || link.workId === event.link.workId)) throw new Error("duplicate work link");
        states.set(event.outcomeId, { ...current, work: [...current.work, event.link] });
        break;
      case "started":
        if (!current || current.state !== "accepted" || current.contract.version !== event.contractVersion || current.work.length !== current.contract.plan.length) throw new Error("illegal start transition");
        states.set(event.outcomeId, { ...current, state: "running" });
        break;
      case "needs-you-requested":
        if (!current || current.state !== "running" || current.contract.version !== event.contractVersion) throw new Error("illegal needs-you transition");
        states.set(event.outcomeId, { ...current, state: "needs-you", needsYou: event.input });
        break;
      case "needs-you-answered":
        if (!current || current.state !== "needs-you" || current.contract.version !== event.contractVersion || current.needsYou.inputKey !== event.inputKey) throw new Error("illegal needs-you answer");
        states.set(event.outcomeId, { ...current, state: "running", needsYou: null, judgment: null });
        break;
      case "judgment-recorded":
        if (!current || (current.state !== "accepted" && current.state !== "running" && current.state !== "needs-you") || current.contract.version !== event.contractVersion) throw new Error("illegal judgment transition");
        states.set(event.outcomeId, { ...current, judgment: event.judgment });
        break;
      case "work-execution-started":
        if (!current || (current.state !== "running" && current.state !== "verifying") || current.contract.version !== event.contractVersion) throw new Error("illegal work execution transition");
        states.set(event.outcomeId, updateWork(current, event.workId, "executing"));
        break;
      case "work-verified":
        if (!current || (current.state !== "running" && current.state !== "verifying") || current.contract.version !== event.contractVersion) throw new Error("illegal work verification transition");
        states.set(event.outcomeId, updateWork(current, event.workId, "verified"));
        break;
      case "work-failed":
        if (!current || !isActiveView(current) || current.contract.version !== event.contractVersion) throw new Error("illegal work failure transition");
        states.set(event.outcomeId, { state: current.contract.rollback.onFailure === "reversible-stop" ? "rolled_back" : "failed", contract: current.contract, work: current.work, evidence: current.evidence, needsYou: null, judgment: current.judgment, receipt: null, reason: event.reason });
        break;
      case "evidence-recorded": {
        const evidence = event.evidence;
        const evidenceState = states.get(evidence.outcomeId);
        if (!evidenceState || terminal(evidenceState.state) || evidenceState.contract.version !== evidence.contractVersion) throw new Error("illegal evidence transition");
        if (evidenceState.evidence.some((item) => item.evidenceId === evidence.evidenceId)) throw new Error("duplicate evidence");
        states.set(evidence.outcomeId, { ...evidenceState, evidence: [...evidenceState.evidence, evidence] });
        break;
      }
      case "verification-recorded":
        if (!current || (current.state !== "running" && current.state !== "verifying") || current.contract.version !== event.contractVersion) throw new Error("illegal verification transition");
        states.set(event.outcomeId, { ...current, state: "verifying", needsYou: null });
        break;
      case "terminal":
        if (!current || terminal(current.state) || current.contract.version !== event.contractVersion) throw new Error("illegal terminal transition");
        states.set(event.outcomeId, terminalView(current, event));
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(`unknown event ${String(exhaustive)}`);
      }
    }
  }
  return states;
}

function workBatchEvent(contract: OutcomeContract, task: OutcomeContract["plan"][number], route: string, captureContentHash?: string) {
  const metadata: JsonObject = { outcomeId: contract.outcomeId, contractVersion: contract.version, taskId: task.id, route };
  if (captureContentHash) metadata.captureContentHash = captureContentHash;
  return {
    type: "worker-batch",
    source: "agent-centipede-v3",
    externalId: `outcome:${contract.outcomeId}:v${contract.version}:task:${task.id}`,
    title: `${contract.objective}: ${task.label}`,
    ownerId: contract.ownerId,
    taskId: `${contract.outcomeId}:v${contract.version}:${task.id}`,
    tasks: [{
      key: task.id,
      label: task.label,
      prompt: task.prompt,
      resumePolicy: task.resumePolicy,
      dependsOn: task.dependsOn,
      resourceLocks: [`outcome:${contract.outcomeId}`],
      metadata,
    }],
  };
}

function grantMatches(contract: OutcomeContract, required: NonNullable<OutcomeContract["plan"][number]["requiredAuthority"]>, now: number): boolean {
  return contract.authority.grants.some((grant) => grant.action === required.action && grant.target === required.target && grant.scope === required.scope && grant.expiresAt >= now);
}

export function projectOutcome(view: OutcomeView): OutcomeProjection {
  const labels = new Map(view.contract.plan.map((task) => [task.id, task.label]));
  return {
    outcomeId: view.contract.outcomeId,
    title: view.contract.objective,
    state: view.state,
    quiet: true,
    work: view.work.map((link) => ({ workId: link.workId, label: labels.get(link.taskId) ?? link.taskId, state: link.status })),
    chatSummary: view.state === "completed"
      ? `Outcome complete: ${view.contract.objective}`
      : view.state === "needs-you"
        ? `Needs you: ${view.needsYou.question}`
        : view.state === "failed" || view.state === "cancelled" || view.state === "rolled_back"
          ? `Outcome ${view.state}: ${view.reason}`
          : `${view.contract.objective} · ${view.state}`,
  };
}

export function createOutcomeOrchestrator(options: OutcomeOrchestratorOptions): OutcomeOrchestrator {
  const now = options.now ?? Date.now;
  const journal = loadJournal(options.journalFile);
  let stored = journal.status === "ready" ? [...journal.events] : [];
  let states: Folded = new Map();
  let journalAvailable = journal.status === "ready";
  if (journal.status === "ready") {
    try { states = fold(stored); } catch { journalAvailable = false; }
  }

  function unavailable(): OutcomeCommandResult {
    return { status: "unavailable", reason: "journal_unavailable" };
  }

  function save(next: StoredEvent): boolean {
    let fd: number | null = null;
    try {
      mkdirSync(dirname(options.journalFile), { recursive: true });
      fd = openSync(options.journalFile, "a", 0o600);
      writeSync(fd, `${JSON.stringify(next)}\n`, undefined, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      const nextStored = [...stored, next];
      const nextStates = fold(nextStored);
      stored = nextStored;
      states = nextStates;
      return true;
    } catch {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
      journalAvailable = false;
      return false;
    }
  }

  function append(event: OutcomeEvent, key: string): "appended" | "duplicate" | "conflict" | "failed" {
    const existing = stored.find((entry) => entry.idempotencyKey === key);
    if (existing) return JSON.stringify(existing.event) === JSON.stringify(event) ? "duplicate" : "conflict";
    const next: StoredEvent = { seq: stored.length + 1, at: now(), idempotencyKey: key, event };
    return save(next) ? "appended" : "failed";
  }

  function result(outcomeId: string, reason?: string, receipt?: OutcomeReceipt): OutcomeCommandResult {
    const view = states.get(outcomeId);
    if (!view) return { status: "denied", reason: "outcome_not_found" };
    if (reason !== undefined) return { status: "blocked", view, reason };
    if (receipt === undefined) return { status: "ok", view };
    return { status: "ok", view, receipt };
  }

  function contractFor(outcomeId: string, version: number): OutcomeView | null {
    const view = states.get(outcomeId);
    if (!view) return null;
    if (view.contract.version !== version || view.contract.outcomeId !== outcomeId) return null;
    return view;
  }

  async function applyContractualJudgment(view: Extract<OutcomeView, { state: "running" }>): Promise<OutcomeCommandResult | null> {
    if (view.judgment !== null) {
      if (view.judgment.color === "red") return { status: "blocked", view, reason: "judgment_red" };
      if (view.judgment.color === "yellow") return { status: "blocked", view, reason: "judgment_needs_you" };
      return null;
    }
    if (!options.judgment) return null;
    let raw: unknown;
    try {
      raw = await options.judgment.judge({
        contract: view.contract,
        workIds: view.work.map((link) => link.workId),
        evidence: view.evidence,
      });
    } catch {
      return { status: "blocked", view, reason: "judgment_unavailable" };
    }
    const parsed = judgmentSchema.safeParse(raw);
    if (!parsed.success) return { status: "blocked", view, reason: "invalid_judgment" };
    const judgment = parsed.data;
    const recorded = append({ type: "judgment-recorded", outcomeId: view.contract.outcomeId, contractVersion: view.contract.version, judgment }, `judgment:${view.contract.id}`);
    if (recorded === "failed") return { status: "unavailable", reason: "journal_write_failed" };
    if (recorded === "conflict") return { status: "blocked", view: states.get(view.contract.outcomeId) ?? view, reason: "judgment_conflict" };
    const judged = states.get(view.contract.outcomeId);
    if (!judged || judged.state !== "running") return { status: "blocked", view: judged ?? view, reason: "judgment_transition_failed" };
    if (judgment.color === "green") return null;
    if (judgment.color === "red") return { status: "blocked", view: judged, reason: "judgment_red" };
    const requested = append({ type: "needs-you-requested", outcomeId: view.contract.outcomeId, contractVersion: view.contract.version, input: judgment.input }, `needs-you:${view.contract.id}:judgment`);
    if (requested === "failed") return { status: "unavailable", reason: "journal_write_failed" };
    const waiting = states.get(view.contract.outcomeId);
    if (!waiting || waiting.state !== "needs-you") return { status: "blocked", view: waiting ?? judged, reason: "needs_you_transition_failed" };
    return { status: "needs_you", view: waiting, input: waiting.needsYou };
  }

  function ensureLinks(view: OutcomeView): OutcomeCommandResult | null {
    if (!["accepted", "running", "needs-you", "verifying"].includes(view.state)) return { status: "blocked", view, reason: "outcome_not_ready_for_work" };
    const existingTaskIds = new Set(view.work.map((link) => link.taskId));
    for (const task of view.contract.plan) {
      if (existingTaskIds.has(task.id)) continue;
      const route = options.learning?.chooseRoute({ outcomeId: view.contract.outcomeId, taskId: task.id, candidates: ["default", "known-safe"] }) ?? "default";
      const response = z.object({ status: z.enum(["created", "unchanged"]), workId: z.string().min(1) }).safeParse(options.work.ingest(workBatchEvent(view.contract, task, route, view.evidence[0]?.contentHash)));
      if (!response.success) return { status: "blocked", view: states.get(view.contract.outcomeId) ?? view, reason: "canonical_work_ingest_denied" };
      const event: OutcomeEvent = { type: "work-linked", outcomeId: view.contract.outcomeId, contractVersion: view.contract.version, link: { taskId: task.id, workId: response.data.workId, status: "planned", route } };
      const appended = append(event, `work-linked:${view.contract.id}:${task.id}`);
      if (appended === "conflict") return { status: "blocked", view: states.get(view.contract.outcomeId) ?? view, reason: "work_link_conflict" };
      if (appended === "failed") return { status: "unavailable", reason: "journal_write_failed" };
      existingTaskIds.add(task.id);
    }
    return null;
  }

  async function run(view: OutcomeView): Promise<OutcomeCommandResult> {
    if (view.state !== "accepted" && view.state !== "running") return { status: "blocked", view, reason: "outcome_not_ready" };
    const linked = ensureLinks(view);
    if (linked) return linked;
    const current = states.get(view.contract.outcomeId);
    if (!current || !["accepted", "running"].includes(current.state)) return { status: "blocked", view: current ?? view, reason: "outcome_changed_during_work_linking" };
    if (current.state === "accepted") {
      if (now() > current.contract.deadline.at) {
        const event: OutcomeEvent = { type: "terminal", outcomeId: current.contract.outcomeId, contractVersion: current.contract.version, state: "failed", reason: "deadline_breached" };
        const appended = append(event, `terminal:${current.contract.id}:deadline`);
        return appended === "failed" ? { status: "unavailable", reason: "journal_write_failed" } : result(current.contract.outcomeId, "deadline_breached");
      }
      const estimatedCostCents = current.contract.plan.reduce((sum, task) => sum + task.estimatedCostCents, 0);
      const estimatedUnits = current.contract.plan.reduce((sum, task) => sum + task.estimatedUnits, 0);
      if (estimatedCostCents > current.contract.budget.maxCostCents || estimatedUnits > current.contract.budget.maxUnits) {
        const event: OutcomeEvent = { type: "terminal", outcomeId: current.contract.outcomeId, contractVersion: current.contract.version, state: "failed", reason: "budget_breached" };
        const appended = append(event, `terminal:${current.contract.id}:budget`);
        return appended === "failed" ? { status: "unavailable", reason: "journal_write_failed" } : result(current.contract.outcomeId, "budget_breached");
      }
      const started: OutcomeEvent = { type: "started", outcomeId: current.contract.outcomeId, contractVersion: current.contract.version };
      const startedAppend = append(started, `started:${current.contract.id}`);
      if (startedAppend === "failed") return { status: "unavailable", reason: "journal_write_failed" };
      const required = current.contract.plan.find((task) => task.needsYou !== null);
      if (required?.needsYou) {
        const event: OutcomeEvent = { type: "needs-you-requested", outcomeId: current.contract.outcomeId, contractVersion: current.contract.version, input: required.needsYou };
        const appended = append(event, `needs-you:${current.contract.id}:${required.needsYou.inputKey}`);
        if (appended === "failed") return { status: "unavailable", reason: "journal_write_failed" };
        const next = states.get(current.contract.outcomeId);
        if (!next || next.state !== "needs-you") return { status: "blocked", view: current, reason: "needs_you_transition_failed" };
        return { status: "needs_you", view: next, input: next.needsYou };
      }
    }
    const running = states.get(view.contract.outcomeId);
    if (!running || running.state !== "running") return { status: "blocked", view: running ?? view, reason: "outcome_not_running" };
    const judged = await applyContractualJudgment(running);
    if (judged) return judged;
    const judgedRunning = states.get(view.contract.outcomeId);
    if (!judgedRunning || judgedRunning.state !== "running") return { status: "blocked", view: judgedRunning ?? running, reason: "outcome_not_running" };
    for (const task of running.contract.plan) {
      const link = judgedRunning.work.find((candidate) => candidate.taskId === task.id);
      if (!link || link.status === "verified") continue;
      if (link.status === "executing" || link.status === "ambiguous") return { status: "blocked", view: running, reason: "work_execution_ambiguous" };
      if (task.requiredAuthority && !grantMatches(running.contract, task.requiredAuthority, now())) {
        const event: OutcomeEvent = { type: "terminal", outcomeId: running.contract.outcomeId, contractVersion: running.contract.version, state: "failed", reason: "authority_denied" };
        const appended = append(event, `terminal:${running.contract.id}:authority:${task.id}`);
        return appended === "failed" ? { status: "unavailable", reason: "journal_write_failed" } : result(running.contract.outcomeId, "authority_denied");
      }
      const executionStarted: OutcomeEvent = { type: "work-execution-started", outcomeId: running.contract.outcomeId, contractVersion: running.contract.version, workId: link.workId };
      const executionAppend = append(executionStarted, `work-execution-started:${running.contract.id}:${link.workId}`);
      if (executionAppend === "failed") return { status: "unavailable", reason: "journal_write_failed" };
      if (executionAppend === "conflict") return { status: "blocked", view: states.get(running.contract.outcomeId) ?? running, reason: "work_execution_conflict" };
      let executed: unknown;
      try { executed = await options.work.execute(link.workId); } catch { return { status: "blocked", view: states.get(running.contract.outcomeId) ?? running, reason: "worker_timeout_or_crash" }; }
      const executeStatus = z.object({ status: z.string() }).safeParse(executed);
      if (!executeStatus.success || executeStatus.data.status === "ambiguous" || executeStatus.data.status === "replay_prevented") return { status: "blocked", view: states.get(running.contract.outcomeId) ?? running, reason: "work_execution_ambiguous" };
      let reconciled: unknown;
      try { reconciled = await options.work.reconcile(link.workId); } catch { return { status: "blocked", view: states.get(running.contract.outcomeId) ?? running, reason: "worker_reconcile_unavailable" }; }
      const reconcileStatus = z.object({ status: z.string() }).safeParse(reconciled);
      if (!reconcileStatus.success || reconcileStatus.data.status === "awaiting_worker") return { status: "blocked", view: states.get(running.contract.outcomeId) ?? running, reason: "worker_timeout_or_crash" };
      if (reconcileStatus.data.status !== "verified") {
        const failed: OutcomeEvent = { type: "work-failed", outcomeId: running.contract.outcomeId, contractVersion: running.contract.version, workId: link.workId, reason: reconcileStatus.data.status === "not_verified" ? "work_not_verified" : "work_reconcile_denied" };
        const appended = append(failed, `work-failed:${running.contract.id}:${link.workId}`);
        return appended === "failed" ? { status: "unavailable", reason: "journal_write_failed" } : result(running.contract.outcomeId, failed.reason);
      }
      const verified: OutcomeEvent = { type: "work-verified", outcomeId: running.contract.outcomeId, contractVersion: running.contract.version, workId: link.workId };
      const verifiedAppend = append(verified, `work-verified:${running.contract.id}:${link.workId}`);
      if (verifiedAppend === "failed") return { status: "unavailable", reason: "journal_write_failed" };
      if (verifiedAppend === "conflict") return { status: "blocked", view: states.get(running.contract.outcomeId) ?? running, reason: "work_verification_conflict" };
    }
    const final = states.get(running.contract.outcomeId);
    return final ? { status: "ok", view: final } : { status: "denied", reason: "outcome_not_found" };
  }

  async function verify(view: OutcomeView): Promise<OutcomeCommandResult> {
    if (view.state !== "running" && view.state !== "verifying") return { status: "blocked", view, reason: "outcome_not_ready" };
    let reconciledWork = false;
    for (const link of view.work) {
      if (link.status === "verified") continue;
      let raw: unknown;
      try { raw = await options.work.reconcile(link.workId); } catch { return { status: "blocked", view, reason: "worker_reconcile_unavailable" }; }
      const parsed = z.object({ status: z.string(), reason: z.string().optional() }).safeParse(raw);
      if (!parsed.success || parsed.data.status === "awaiting_worker" || parsed.data.status === "awaiting_receipt") return { status: "blocked", view, reason: "work_incomplete" };
      if (parsed.data.status === "replay_prevented") return { status: "blocked", view, reason: "work_execution_ambiguous" };
      if (parsed.data.status === "not_verified") {
        const failed: OutcomeEvent = { type: "work-failed", outcomeId: view.contract.outcomeId, contractVersion: view.contract.version, workId: link.workId, reason: parsed.data.reason ?? "work_not_verified" };
        const appended = append(failed, `work-failed:${view.contract.id}:${link.workId}`);
        if (appended === "failed") return { status: "unavailable", reason: "journal_write_failed" };
        return result(view.contract.outcomeId, failed.reason);
      }
      if (parsed.data.status !== "verified") return { status: "blocked", view, reason: "work_incomplete" };
      const appended = append({ type: "work-verified", outcomeId: view.contract.outcomeId, contractVersion: view.contract.version, workId: link.workId }, `work-verified:${view.contract.id}:${link.workId}`);
      if (appended === "failed") return { status: "unavailable", reason: "journal_write_failed" };
      if (appended === "conflict") return { status: "blocked", view: states.get(view.contract.outcomeId) ?? view, reason: "work_verification_conflict" };
      reconciledWork = true;
    }
    if (reconciledWork) {
      const refreshed = states.get(view.contract.outcomeId);
      return refreshed ? verify(refreshed) : { status: "denied", reason: "outcome_not_found" };
    }
    const allVerified = view.work.length === view.contract.plan.length && view.work.every((link) => link.status === "verified");
    if (!allVerified) return { status: "blocked", view, reason: "work_incomplete" };
    const requiredCriteria = new Set(view.contract.evidenceRequirements.requiredCriterionIds);
    const coveredCriteria = new Set(view.evidence.flatMap((evidence) => evidence.criterionIds));
    if ([...requiredCriteria].some((criterion) => !coveredCriteria.has(criterion))) return { status: "blocked", view, reason: "evidence_missing" };
    const artifacts = view.evidence.flatMap((evidence) => evidence.artifacts);
    const requiredKinds = new Set(view.contract.evidenceRequirements.requiredArtifactKinds);
    if ([...requiredKinds].some((kind) => !artifacts.some((artifact) => artifact.kind === kind))) return { status: "blocked", view, reason: "artifact_missing" };
    const expectedWorkIds = view.work.map((link) => link.workId);
    const expectedEvidenceRefs = view.evidence.map((evidence) => evidence.reference);
    const expectedArtifactRefs = artifacts.map((artifact) => artifact.reference);
    const expectedTraceIdentity = traceIdentity({ contractId: view.contract.id, contractVersion: view.contract.version, workIds: expectedWorkIds, evidenceRefs: expectedEvidenceRefs, criteriaHash: criteriaHash(view.contract) });
    const verifying: OutcomeEvent = { type: "verification-recorded", outcomeId: view.contract.outcomeId, contractVersion: view.contract.version };
    const verifyingAppend = append(verifying, `verification-recorded:${view.contract.id}`);
    if (verifyingAppend === "failed") return { status: "unavailable", reason: "journal_write_failed" };
    let raw: unknown;
    try {
      raw = await options.verifier.verify({ contract: view.contract, workIds: expectedWorkIds, evidence: view.evidence, artifacts, criteriaHash: criteriaHash(view.contract), traceIdentity: expectedTraceIdentity });
    } catch { return { status: "blocked", view: states.get(view.contract.outcomeId) ?? view, reason: "verifier_unavailable" }; }
    const verdict = verificationSchema.safeParse(raw);
    if (!verdict.success || verdict.data.contractId !== view.contract.id || verdict.data.contractVersion !== view.contract.version || verdict.data.criteriaHash !== criteriaHash(view.contract) || verdict.data.traceIdentity !== expectedTraceIdentity || JSON.stringify(verdict.data.evidenceRefs) !== JSON.stringify(expectedEvidenceRefs) || JSON.stringify(verdict.data.artifactRefs) !== JSON.stringify(expectedArtifactRefs)) return { status: "blocked", view: states.get(view.contract.outcomeId) ?? view, reason: "stale_verifier" };
    if (now() > view.contract.deadline.at) return { status: "blocked", view: states.get(view.contract.outcomeId) ?? view, reason: "deadline_breached" };
    if (verdict.data.usage.costCents > view.contract.budget.maxCostCents || verdict.data.usage.units > view.contract.budget.maxUnits) return { status: "blocked", view: states.get(view.contract.outcomeId) ?? view, reason: "budget_breached" };
    const verifiedAt = now();
    const finalTraceEntry: ExecutionTraceEntry = { seq: stored.length + 1, at: verifiedAt, phase: "terminal", action: "outcome-completed", refs: [`outcome:${view.contract.outcomeId}:v${view.contract.version}`, `verified:${view.contract.outcomeId}:v${view.contract.version}`, `retrospective:${view.contract.outcomeId}:v${view.contract.version}`], detail: "independently-verified-output persisted; retrospective persisted" };
    const record = buildOutcomeRecord({
      outcomeId: view.contract.outcomeId,
      contractId: view.contract.id,
      contractVersion: view.contract.version,
      objective: view.contract.objective,
      contextRefs: [`contract:${view.contract.id}`, ...expectedEvidenceRefs],
      evidenceRefs: expectedEvidenceRefs,
      evidenceIds: view.evidence.map((evidence) => evidence.evidenceId),
      workIds: expectedWorkIds,
      traceEntries: [...stored.map(traceEntry), finalTraceEntry],
      criteriaHash: verdict.data.criteriaHash,
      artifactRefs: expectedArtifactRefs,
      verifiedAt,
      usage: verdict.data.usage,
      startedAt: stored.find((entry) => entry.event.type === "started")?.at ?? null,
      needsYouTouches: stored.filter((entry) => entry.event.type === "needs-you-answered").length,
      requiredContextCount: 1,
      coveredContextCount: expectedEvidenceRefs.length > 0 ? 1 : 0,
    });
    const receipt: OutcomeReceipt = { kind: "outcome-completed", outcomeId: view.contract.outcomeId, contractId: view.contract.id, contractVersion: view.contract.version, criteriaHash: verdict.data.criteriaHash, workIds: expectedWorkIds, evidenceRefs: expectedEvidenceRefs.map(redactEvidenceReference), artifactRefs: expectedArtifactRefs.map(redactEvidenceReference), verifiedAt, usage: verdict.data.usage, record };
    const terminalEvent: OutcomeEvent = { type: "terminal", outcomeId: view.contract.outcomeId, contractVersion: view.contract.version, state: "completed", receipt };
    const appended = append(terminalEvent, `terminal:${view.contract.id}:completed`);
    if (appended === "failed") return { status: "unavailable", reason: "journal_write_failed" };
    if (options.learning) {
      try { options.learning.record(record); } catch { /* the receipt remains the canonical durable learning record */ }
    }
    return result(view.contract.outcomeId, undefined, receipt);
  }

  async function capture(evidence: CaptureEvidence): Promise<OutcomeCommandResult> {
    const prior = stored.find((entry) => entry.event.type === "capture-linked" && (
      entry.event.capture.captureId === evidence.captureId ||
      (entry.event.capture.source === evidence.source && entry.event.capture.contentHash === evidence.contentHash)
    ));
    if (prior && prior.event.type === "capture-linked") {
      if (prior.event.capture.captureId === evidence.captureId && JSON.stringify(prior.event.capture) !== JSON.stringify(evidence)) return { status: "denied", reason: "capture_conflict" };
      const replayed = states.get(prior.event.outcomeId);
      if (!replayed) return { status: "denied", reason: "outcome_not_found" };
      if (replayed.state === "needs-you") return { status: "needs_you", view: replayed, input: replayed.needsYou };
      if (replayed.judgment?.color === "red") return { status: "blocked", view: replayed, reason: "judgment_red" };
      return result(prior.event.outcomeId);
    }
    if (evidence.confidence !== "high") return { status: "blocked", reason: "capture_ambiguous" };
    if (!options.captureInference) return { status: "blocked", reason: "capture_inference_unavailable" };
    if (!options.judgment) return { status: "blocked", reason: "judgment_unavailable" };

    let raw: unknown;
    try {
      raw = await options.captureInference.infer({
        evidence,
        existingOutcomes: [...states.values()].map((view) => ({
          outcomeId: view.contract.outcomeId,
          contractVersion: view.contract.version,
          objective: view.contract.objective,
          state: view.state,
        })),
      });
    } catch {
      return { status: "blocked", reason: "capture_inference_unavailable" };
    }
    const inferred = inferenceSchema.safeParse(raw);
    if (!inferred.success) return { status: "blocked", reason: "capture_ambiguous" };
    if (inferred.data.status === "ambiguous") return { status: "blocked", reason: "capture_ambiguous" };

    let target: OutcomeView | null;
    if (inferred.data.status === "inferred") {
      const existing = states.get(inferred.data.contract.outcomeId);
      if (existing) {
        if (existing.contract.id !== inferred.data.contract.id || existing.contract.version !== inferred.data.contract.version) return { status: "denied", reason: "capture_contract_conflict", view: existing };
        target = existing;
      } else {
        const declared = append({ type: "declared", contract: inferred.data.contract }, `declared:${inferred.data.contract.id}`);
        if (declared === "failed") return { status: "unavailable", reason: "journal_write_failed" };
        if (declared === "conflict") return { status: "denied", reason: "capture_contract_conflict" };
        const accepted = append({ type: "accepted", outcomeId: inferred.data.contract.outcomeId, contractVersion: inferred.data.contract.version }, `accepted:${inferred.data.contract.id}`);
        if (accepted === "failed") return { status: "unavailable", reason: "journal_write_failed" };
        target = states.get(inferred.data.contract.outcomeId) ?? null;
      }
    } else {
      target = contractFor(inferred.data.outcomeId, inferred.data.contractVersion);
      if (!target) return { status: "blocked", reason: "capture_outcome_missing" };
    }
    if (!target || (target.state !== "accepted" && target.state !== "running")) return { status: "blocked", view: target ?? undefined, reason: "outcome_not_ready" };
    const linked = ensureLinks(target);
    if (linked) return linked;
    const captureLink = append({ type: "capture-linked", outcomeId: target.contract.outcomeId, contractVersion: target.contract.version, capture: evidence }, `capture:${evidence.captureId}`);
    if (captureLink === "failed") return { status: "unavailable", reason: "journal_write_failed" };
    if (captureLink === "conflict") return { status: "denied", reason: "capture_conflict", view: states.get(target.contract.outcomeId) };
    const ready = states.get(target.contract.outcomeId);
    if (!ready || (ready.state !== "accepted" && ready.state !== "running")) return { status: "blocked", view: ready ?? target, reason: "outcome_changed_during_capture" };
    return run(ready);
  }

  async function dispatch(rawCommand: unknown): Promise<OutcomeCommandResult> {
    if (!journalAvailable) return unavailable();
    const parsed = commandSchema.safeParse(rawCommand);
    if (!parsed.success) return { status: "denied", reason: "invalid_command" };
    const command = parsed.data;
    switch (command.kind) {
      case "declare": {
        if (states.has(command.contract.outcomeId)) return { status: "denied", reason: "outcome_already_exists", view: states.get(command.contract.outcomeId) };
        const declared: OutcomeEvent = { type: "declared", contract: command.contract };
        const appended = append(declared, `declared:${command.contract.id}`);
        if (appended === "conflict") return { status: "denied", reason: "declaration_conflict" };
        if (appended === "failed") return { status: "unavailable", reason: "journal_write_failed" };
        return result(command.contract.outcomeId);
      }
      case "capture":
        return capture(command.evidence);
      case "accept": {
        const view = contractFor(command.outcomeId, command.contractVersion);
        if (!view) return { status: "denied", reason: "contract_version_mismatch_or_missing" };
        if (terminal(view.state)) return { status: "denied", reason: "terminal_state", view };
        if (view.state === "declared") {
          const appended = append({ type: "accepted", outcomeId: command.outcomeId, contractVersion: command.contractVersion }, `accepted:${view.contract.id}`);
          if (appended === "failed") return { status: "unavailable", reason: "journal_write_failed" };
        }
        const accepted = states.get(command.outcomeId);
        if (!accepted || !["accepted", "running", "needs-you", "verifying"].includes(accepted.state)) return { status: "blocked", view: accepted ?? view, reason: "contract_not_accepted" };
        return ensureLinks(accepted) ?? result(command.outcomeId);
      }
      case "run": {
        const view = contractFor(command.outcomeId, command.contractVersion);
        if (!view) return { status: "denied", reason: "outcome_not_ready" };
        if (view.state !== "accepted" && view.state !== "running") return { status: "denied", reason: "outcome_not_ready", view };
        return run(view);
      }
      case "answer-needs-you": {
        const view = contractFor(command.outcomeId, command.contractVersion);
        if (!view) return { status: "denied", reason: "needs_you_mismatch" };
        if (view.state !== "needs-you" || view.needsYou.inputKey !== command.inputKey) return { status: "denied", reason: "needs_you_mismatch", view };
        const appended = append({ type: "needs-you-answered", outcomeId: command.outcomeId, contractVersion: command.contractVersion, inputKey: command.inputKey, answerHash: createHash("sha256").update(command.answer, "utf8").digest("hex"), answerLength: command.answer.length, answeredBy: command.answeredBy, answeredAt: now() }, `needs-you-answered:${view.contract.id}:${command.inputKey}`);
        if (appended === "failed") return { status: "unavailable", reason: "journal_write_failed" };
        return result(command.outcomeId);
      }
      case "record-evidence": {
        const evidence = command.evidence;
        const view = contractFor(evidence.outcomeId, evidence.contractVersion);
        if (!view) return { status: "denied", reason: "evidence_contract_mismatch" };
        if (terminal(view.state)) return { status: "denied", reason: "terminal_state", view };
        const duplicate = view.evidence.find((item) => item.evidenceId === evidence.evidenceId);
        if (duplicate) return JSON.stringify(duplicate) === JSON.stringify(evidence) ? result(evidence.outcomeId) : { status: "denied", reason: "evidence_conflict", view };
        const appended = append({ type: "evidence-recorded", evidence }, `evidence:${view.contract.id}:${evidence.evidenceId}`);
        if (appended === "conflict") return { status: "denied", reason: "evidence_conflict", view };
        if (appended === "failed") return { status: "unavailable", reason: "journal_write_failed" };
        return result(evidence.outcomeId);
      }
      case "verify": {
        const view = contractFor(command.outcomeId, command.contractVersion);
        if (!view) return { status: "denied", reason: "outcome_not_ready" };
        if (view.state !== "running" && view.state !== "verifying") return { status: "denied", reason: "outcome_not_ready", view };
        return verify(view);
      }
      case "cancel": {
        const view = contractFor(command.outcomeId, command.contractVersion);
        if (!view) return { status: "denied", reason: "terminal_state_or_missing" };
        if (terminal(view.state)) return { status: "denied", reason: "terminal_state_or_missing", view };
        const state = view.contract.rollback.onCancel === "reversible-stop" ? "rolled_back" : "cancelled";
        const appended = append({ type: "terminal", outcomeId: command.outcomeId, contractVersion: command.contractVersion, state, reason: command.reason }, `terminal:${view.contract.id}:${state}`);
        if (appended === "failed") return { status: "unavailable", reason: "journal_write_failed" };
        return result(command.outcomeId);
      }
      default: {
        const exhaustive: never = command;
        return { status: "denied", reason: `unknown_command:${String(exhaustive)}` };
      }
    }
  }

  return {
    dispatch,
    inspect(outcomeId) {
      if (!journalAvailable) return { status: "unavailable" };
      const view = states.get(outcomeId);
      return view ? { status: "available", view } : { status: "missing" };
    },
  };
}
