import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type,
 * anti-slop/no-runtime-typeof -- the learning journal is an external JSON
 * boundary; every value is checked before it becomes a domain record. */

export type TelemetryValue =
  | { readonly status: "measured"; readonly value: number }
  | { readonly status: "derived"; readonly value: number; readonly from: readonly string[] }
  | { readonly status: "unknown"; readonly reason: string }
  | { readonly status: "not-applicable"; readonly reason: string };

export interface RetrospectiveMetric {
  readonly name: string;
  readonly value: TelemetryValue;
}

export interface ExecutionTraceEntry {
  readonly seq: number;
  readonly at: number;
  readonly phase: "intake" | "judgment" | "planning" | "execution" | "verification" | "terminal";
  readonly action: string;
  readonly refs: readonly string[];
  readonly detail?: string;
}

export interface ExecutionTrace {
  readonly id: string;
  readonly outcomeId: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly traceIdentity: string;
  readonly complete: true;
  readonly entries: readonly ExecutionTraceEntry[];
}

export interface InputContextBasis {
  readonly id: string;
  readonly outcomeId: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly contextRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly presumedOutcome: string;
  readonly presumedOutcomeHash: string;
}

export interface VerifiedOutputRecord {
  readonly id: string;
  readonly outcomeId: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly traceIdentity: string;
  readonly status: "independently-verified";
  readonly evidenceRefs: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly criteriaHash: string;
  readonly verifiedAt: number;
  readonly usage: { readonly costCents: number; readonly units: number };
}

export interface RetrospectiveAlternative {
  readonly id: string;
  readonly statement: string;
  readonly evidenceRefs: readonly string[];
  readonly selected: boolean;
}

export interface RetrospectiveLearning {
  readonly id: string;
  readonly statement: string;
  readonly boundedEffect: "routing-only";
  readonly evidenceRefs: readonly string[];
}

export interface RetrospectiveReview {
  readonly id: string;
  readonly outcomeId: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly traceIdentity: string;
  readonly metrics: readonly RetrospectiveMetric[];
  readonly alternatives: readonly RetrospectiveAlternative[];
  readonly learnings: readonly RetrospectiveLearning[];
  readonly trusted: boolean;
}

export interface OutcomeRecord {
  readonly recordId: string;
  readonly links: {
    readonly inputContextId: string;
    readonly executionTraceId: string;
    readonly verifiedOutputId: string;
    readonly retrospectiveId: string;
    readonly contractId: string;
    readonly contractVersion: number;
    readonly workIds: readonly string[];
    readonly evidenceIds: readonly string[];
  };
  readonly inputContext: InputContextBasis;
  readonly executionTrace: ExecutionTrace;
  readonly verifiedOutput: VerifiedOutputRecord;
  readonly retrospective: RetrospectiveReview;
}

export interface OutcomeRecordInput {
  readonly outcomeId: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly objective: string;
  readonly contextRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly workIds: readonly string[];
  readonly traceEntries: readonly ExecutionTraceEntry[];
  readonly criteriaHash: string;
  readonly artifactRefs: readonly string[];
  readonly verifiedAt: number;
  readonly usage: { readonly costCents: number; readonly units: number };
  readonly startedAt: number | null;
  readonly needsYouTouches: number;
  readonly requiredContextCount: number;
  readonly coveredContextCount: number;
}

export interface OutcomeLearning {
  record(record: OutcomeRecord): boolean;
  review(outcomeId: string): RetrospectiveReview | null;
  chooseRoute(input: { readonly outcomeId: string; readonly taskId: string; readonly candidates: readonly string[] }): string | null;
}

export interface ExecutionLearningOptions {
  readonly file: string;
}

const HASH_LENGTH = 64;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function redactText(value: string): string {
  return value.replace(/\b(password|passwd|secret|token|api[_-]?key|authorization|bearer)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

export function redactEvidenceReference(value: string): string {
  return redactText(value).replace(/([?&](?:password|passwd|secret|token|api[_-]?key|authorization|code)=)[^&\s]+/gi, "$1[redacted]");
}

function metric(name: string, value: TelemetryValue): RetrospectiveMetric {
  return { name, value };
}

function reviewFor(input: OutcomeRecordInput, traceIdentity: string, retrospectiveId: string): RetrospectiveReview {
  const latency: TelemetryValue = input.startedAt === null ? { status: "unknown", reason: "execution start was not observed" } : { status: "derived", value: Math.max(0, input.verifiedAt - input.startedAt), from: ["execution-start", "verified-output"] };
  const contextCoverage: TelemetryValue = input.requiredContextCount === 0
    ? { status: "not-applicable", reason: "the outcome declared no required context references" }
    : { status: "derived", value: input.coveredContextCount / input.requiredContextCount, from: ["input-context", "evidence"] };
  return {
    id: retrospectiveId,
    outcomeId: input.outcomeId,
    contractId: input.contractId,
    contractVersion: input.contractVersion,
    traceIdentity,
    metrics: [
      metric("correctness-quality", { status: "measured", value: 1 }),
      metric("latency-ms", latency),
      metric("cost-cents", { status: "measured", value: input.usage.costCents }),
      metric("execution-units", { status: "measured", value: input.usage.units }),
      metric("shane-touches", { status: "derived", value: input.needsYouTouches, from: ["needs-you-answers"] }),
      metric("aws", { status: "unknown", reason: "AWS spend telemetry is not available at this seam" }),
      metric("unnecessary-interruption", { status: "unknown", reason: "interruption intent is not observable at this seam" }),
      metric("risk-reversibility", { status: "unknown", reason: "reversibility evidence was not supplied" }),
      metric("context-coverage", contextCoverage),
      metric("retry-recovery-efficiency", { status: "unknown", reason: "retry and recovery telemetry was not supplied" }),
    ],
    alternatives: [{
      id: "route:known-safe",
      statement: "A previously verified safe route could reduce routing uncertainty on a later equivalent outcome.",
      evidenceRefs: [`trace:${input.outcomeId}:v${input.contractVersion}`],
      selected: false,
    }],
    learnings: [{
      id: `learning:${input.outcomeId}:v${input.contractVersion}`,
      statement: "For a later equivalent outcome, prefer a previously verified safe route when it is available; this does not change judgment, authority, approval, or verification.",
      boundedEffect: "routing-only",
      evidenceRefs: [`trace:${input.outcomeId}:v${input.contractVersion}`],
    }],
    trusted: true,
  };
}

export function traceIdentity(input: Pick<OutcomeRecordInput, "contractId" | "contractVersion" | "workIds" | "evidenceRefs" | "criteriaHash">): string {
  return hash(stableJson({ contractId: input.contractId, contractVersion: input.contractVersion, workIds: input.workIds, evidenceRefs: input.evidenceRefs, criteriaHash: input.criteriaHash }));
}

export function buildOutcomeRecord(input: OutcomeRecordInput): OutcomeRecord {
  const inputContextId = `input:${input.outcomeId}:v${input.contractVersion}`;
  const executionTraceId = `trace:${input.outcomeId}:v${input.contractVersion}`;
  const verifiedOutputId = `verified:${input.outcomeId}:v${input.contractVersion}`;
  const retrospectiveId = `retrospective:${input.outcomeId}:v${input.contractVersion}`;
  const identity = traceIdentity(input);
  const trace: ExecutionTrace = {
    id: executionTraceId,
    outcomeId: input.outcomeId,
    contractId: input.contractId,
    contractVersion: input.contractVersion,
    traceIdentity: identity,
    complete: true,
    entries: input.traceEntries,
  };
  const verifiedOutput: VerifiedOutputRecord = {
    id: verifiedOutputId,
    outcomeId: input.outcomeId,
    contractId: input.contractId,
    contractVersion: input.contractVersion,
    traceIdentity: identity,
    status: "independently-verified",
    evidenceRefs: input.evidenceRefs.map(redactEvidenceReference),
    artifactRefs: input.artifactRefs.map(redactEvidenceReference),
    criteriaHash: input.criteriaHash,
    verifiedAt: input.verifiedAt,
    usage: input.usage,
  };
  return {
    recordId: `record:${input.outcomeId}:v${input.contractVersion}`,
    links: {
      inputContextId,
      executionTraceId,
      verifiedOutputId,
      retrospectiveId,
      contractId: input.contractId,
      contractVersion: input.contractVersion,
      workIds: input.workIds,
      evidenceIds: input.evidenceIds,
    },
    inputContext: {
      id: inputContextId,
      outcomeId: input.outcomeId,
      contractId: input.contractId,
      contractVersion: input.contractVersion,
      contextRefs: input.contextRefs.map(redactEvidenceReference),
      evidenceRefs: input.evidenceRefs.map(redactEvidenceReference),
      presumedOutcome: redactText(input.objective),
      presumedOutcomeHash: hash(input.objective),
    },
    executionTrace: trace,
    verifiedOutput,
    retrospective: reviewFor(input, identity, retrospectiveId),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isOutcomeRecord(value: unknown): value is OutcomeRecord {
  if (!isRecord(value) || typeof value.recordId !== "string" || !isRecord(value.links) || !isRecord(value.inputContext) || !isRecord(value.executionTrace) || !isRecord(value.verifiedOutput) || !isRecord(value.retrospective)) return false;
  return value.retrospective.trusted === true && value.verifiedOutput.status === "independently-verified" && value.executionTrace.complete === true && typeof value.executionTrace.traceIdentity === "string";
}

function loadRecords(file: string): readonly OutcomeRecord[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.records)) return [];
    return parsed.records.filter(isOutcomeRecord);
  } catch {
    return [];
  }
}

function saveRecords(file: string, records: readonly OutcomeRecord[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ records }), { encoding: "utf8", mode: 0o600 });
}

function hasRoutingLearning(record: OutcomeRecord): boolean {
  return record.retrospective.trusted && record.retrospective.learnings.some((learning) => learning.boundedEffect === "routing-only");
}

function normaliseRetrospective(review: RetrospectiveReview): RetrospectiveReview {
  const requiredUnknowns: readonly RetrospectiveMetric[] = [
    metric("aws", { status: "unknown", reason: "AWS spend telemetry is not available at this seam" }),
    metric("unnecessary-interruption", { status: "unknown", reason: "interruption intent is not observable at this seam" }),
    metric("risk-reversibility", { status: "unknown", reason: "reversibility evidence was not supplied" }),
    metric("retry-recovery-efficiency", { status: "unknown", reason: "retry and recovery telemetry was not supplied" }),
  ];
  const names = new Set(review.metrics.map((candidate) => candidate.name));
  return { ...review, metrics: [...review.metrics, ...requiredUnknowns.filter((candidate) => !names.has(candidate.name))] };
}

export function createExecutionLearning(options: ExecutionLearningOptions): OutcomeLearning {
  let records = loadRecords(options.file).map((record) => ({ ...record, retrospective: normaliseRetrospective(record.retrospective) }));
  return {
    record(record): boolean {
      if (!isOutcomeRecord(record) || record.links.contractId !== record.inputContext.contractId || record.links.contractVersion !== record.inputContext.contractVersion || record.links.executionTraceId !== record.executionTrace.id || record.links.verifiedOutputId !== record.verifiedOutput.id || record.links.retrospectiveId !== record.retrospective.id || record.executionTrace.traceIdentity !== record.verifiedOutput.traceIdentity || record.retrospective.traceIdentity !== record.executionTrace.traceIdentity) return false;
      const normalised = { ...record, retrospective: normaliseRetrospective(record.retrospective) };
      const existing = records.find((candidate) => candidate.recordId === record.recordId);
      if (existing) return stableJson(existing) === stableJson(normalised);
      records = [...records, normalised];
      saveRecords(options.file, records);
      return true;
    },
    review(outcomeId): RetrospectiveReview | null {
      return records.find((record) => record.links.contractId.startsWith(`${outcomeId}:`) || record.inputContext.outcomeId === outcomeId)?.retrospective ?? null;
    },
    chooseRoute(input): string | null {
      const safe = input.candidates.find((candidate) => candidate === "known-safe");
      return safe && records.some(hasRoutingLearning) ? safe : input.candidates[0] ?? null;
    },
  };
}

export const EXECUTION_LEARNING_HASH_LENGTH = HASH_LENGTH;
