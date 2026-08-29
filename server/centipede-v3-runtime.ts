import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AccountDirectory, JsonFileAccountDirectoryStore } from "./account-directory.ts";
import { ActionPolicy } from "./action-policy.ts";
import { AutonomyTelemetry } from "./autonomy-telemetry.ts";
import { createExecutionLearning } from "./execution-learning.ts";
import {
  createOutcomeOrchestrator,
  captureContextDelta,
  projectOutcome,
  type CaptureEvidence,
  type CaptureContextDelta,
  type CaptureInferenceInput,
  type CaptureOutcomeInference,
  type ContractualJudgment,
  type ExistingWorkOrchestrator,
  type OutcomeCommandResult,
  type OutcomeContract,
  type OutcomeOrchestrator,
  type OutcomeProjection,
  type OutcomeReceipt,
  type OutcomeVerifier,
  type OutcomeView,
} from "./outcome-orchestrator.ts";
import { createWorkerJobFileStore } from "./worker-job-file-store.ts";
import { createWorkerJobs, type WorkerJobRecord, type WorkerJobStore } from "./worker-jobs.ts";
import { createWorkLockStore, type WorkLockStoreInterface, type WorkObligation } from "./work-lock-store.ts";
import { createWorkOrchestrator, type WorkOrchestrator } from "./work-orchestrator.ts";
import type { JsonObject, JsonValue } from "./schema.ts";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns,
 * anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type,
 * anti-slop/no-known-value-widening -- the public command seam is unknown by
 * design; all durable and worker values are validated by their owning module. */

export interface CentipedeV3RuntimeOptions {
  readonly dataDir: string;
  readonly now?: () => number;
  /** Production desktop wiring supplies the existing turn runner. The
   * default is a bounded local worker for the standalone runtime seam. */
  readonly workerRunner?: (job: Readonly<WorkerJobRecord>) => JsonValue | undefined | Promise<JsonValue | undefined>;
}

export interface ContextGraph {
  readonly nodes: readonly {
    readonly id: string;
    readonly type: "capture" | "outcome" | "verified-outcome" | "receipt" | "learning" | "entity" | "relationship" | "constraint" | "dependency";
    readonly provenance?: {
      readonly source: string;
      readonly reference: string;
      readonly contentHash: string;
      readonly observedAt: number;
    };
    readonly contractId?: string;
    readonly contractVersion?: number;
    readonly receiptReference?: string;
  }[];
  readonly edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly kind: "supports" | "related-to" | "conflicts" | "depends-on" | "produced-by" | "learned-from";
  }[];
}

export interface CentipedeV3Runtime {
  dispatch(command: unknown): Promise<OutcomeCommandResult>;
  inspectContext(): ContextGraph;
  inspectOutcome(outcomeId: string): OutcomeProjection | null;
  inspectOutcomeReceipt(outcomeId: string): OutcomeReceipt | null;
  inspectCanonicalWork(outcomeId: string): readonly WorkObligation[];
  userContract(outcomeId: string, objective: string): OutcomeContract;
  workExecutionCount(): number;
  close(): void;
}

const graphFileName = "centipede-v3-context.json";

function emptyGraph(): ContextGraph {
  return { nodes: [], edges: [] };
}

function loadGraph(file: string): ContextGraph {
  if (!existsSync(file)) return emptyGraph();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return emptyGraph();
    const nodes = parsed.nodes.filter(isGraphNode);
    const edges = parsed.edges.filter(isGraphEdge);
    return { nodes, edges };
  } catch {
    return emptyGraph();
  }
}

function saveGraph(file: string, graph: ContextGraph): void {
  writeFileSync(file, JSON.stringify(graph), { encoding: "utf8", mode: 0o600 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGraphNode(value: unknown): value is ContextGraph["nodes"][number] {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  if (value.type !== "capture" && value.type !== "outcome" && value.type !== "verified-outcome" && value.type !== "receipt" && value.type !== "learning" && value.type !== "entity" && value.type !== "relationship" && value.type !== "constraint" && value.type !== "dependency") return false;
  if (value.provenance !== undefined) {
    if (!isRecord(value.provenance) || typeof value.provenance.source !== "string" || typeof value.provenance.reference !== "string" || typeof value.provenance.contentHash !== "string" || typeof value.provenance.observedAt !== "number") return false;
  }
  return value.contractId === undefined || typeof value.contractId === "string";
}

function mergeCaptureContext(graph: ContextGraph, delta: CaptureContextDelta | null): ContextGraph {
  if (!delta) return graph;
  const nodes = [...graph.nodes];
  for (const node of delta.nodes) {
    const index = nodes.findIndex((candidate) => candidate.id === node.id);
    if (index < 0) nodes.push(node);
    else nodes[index] = { ...nodes[index], ...node };
  }
  const edges = [...graph.edges];
  for (const edge of delta.edges) {
    if (!edges.some((candidate) => candidate.from === edge.from && candidate.to === edge.to && candidate.kind === edge.kind)) edges.push(edge);
  }
  return { nodes, edges };
}

function isGraphEdge(value: unknown): value is ContextGraph["edges"][number] {
  return isRecord(value) && typeof value.from === "string" && typeof value.to === "string" && (value.kind === "supports" || value.kind === "related-to" || value.kind === "conflicts" || value.kind === "depends-on" || value.kind === "produced-by" || value.kind === "learned-from");
}

function normalizedTokens(value: string): ReadonlySet<string> {
  return new Set(value.normalize("NFKC").toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 2));
}

function tokenOverlap(left: string, right: string): number {
  const a = normalizedTokens(left);
  const b = normalizedTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let matches = 0;
  for (const token of a) if (b.has(token)) matches += 1;
  return matches / Math.max(a.size, b.size);
}

function captureMatchesGraph(graph: ContextGraph, evidence: CaptureEvidence, outcomeId: string): boolean {
  const captureNode = graph.nodes.find((node) => node.id === `capture:${evidence.captureId}`);
  if (!captureNode) return false;
  const relationship = graph.edges.filter((edge) => edge.from === captureNode.id && edge.to === `outcome:${outcomeId}`);
  if (relationship.some((edge) => edge.kind === "conflicts")) return false;
  return relationship.some((edge) => edge.kind === "supports" || edge.kind === "related-to" || edge.kind === "depends-on");
}

function captureConflictsWithOutcome(graph: ContextGraph, evidence: CaptureEvidence, outcomeId: string): boolean {
  return graph.edges.some((edge) => edge.from === `capture:${evidence.captureId}` && edge.to === `outcome:${outcomeId}` && edge.kind === "conflicts");
}

function createCaptureInference(getGraph: () => ContextGraph, work: WorkLockStoreInterface): CaptureOutcomeInference {
  return {
    async infer(input: CaptureInferenceInput): Promise<unknown> {
      const graph = mergeCaptureContext(getGraph(), input.evidence.contextDelta ?? null);
      const active = input.existingOutcomes.filter((outcome) => outcome.state === "accepted" || outcome.state === "running" || outcome.state === "needs-you" || outcome.state === "verifying");
      const related = active.find((outcome) => !captureConflictsWithOutcome(graph, input.evidence, outcome.outcomeId) && (captureMatchesGraph(graph, input.evidence, outcome.outcomeId) || tokenOverlap(input.evidence.summary, outcome.objective) >= 0.6));
      const canonical = work.listOpenWork({ statuses: ["open", "in_progress", "blocked", "completed"], limit: 1_000 }).obligations.find((obligation) => {
        if (!isRecord(obligation.metadata)) return false;
        return obligation.metadata.captureContentHash === input.evidence.contentHash;
      });
      const metadata = canonical?.metadata;
      if (metadata && isRecord(metadata) && typeof metadata.outcomeId === "string") {
        const existing = input.existingOutcomes.find((candidate) => candidate.outcomeId === metadata.outcomeId);
        if (existing) return { status: "existing", outcomeId: existing.outcomeId, contractVersion: existing.contractVersion };
      }
      if (related) return { status: "existing", outcomeId: related.outcomeId, contractVersion: related.contractVersion };
      if (input.evidence.confidence !== "high") return { status: "ambiguous", reason: "Capture confidence is below the execution threshold." };

      const outcomeId = input.evidence.captureId;
      return {
        status: "inferred",
        contract: {
          id: `${outcomeId}:v1`,
          outcomeId,
          version: 1,
          ownerId: "shane",
          objective: input.evidence.summary,
          constraints: [
            { kind: "scope", statement: "Use only the provenance-bearing Capture observation and canonical Work." },
            { kind: "privacy", statement: "Do not disclose Capture content outside the bound local runtime." },
          ],
          successCriteria: [{ id: "receipt", statement: "Canonical Work is independently verified against this Contract version." }],
          deadline: { at: input.evidence.observedAt + 86_400_000 },
          budget: { currency: "USD", maxCostCents: 100, maxUnits: 10 },
          qualityBar: "Exact Contract binding, bounded execution, and independent verification",
          authority: { mode: "deny-by-default", grants: [] },
          escalation: { channel: "needs-you", on: ["missing-input", "deadline-risk", "budget-risk", "quality-risk", "authority-required"] },
          evidenceRequirements: { requiredCriterionIds: ["receipt"], requiredArtifactKinds: ["receipt"] },
          rollback: { onCancel: "reversible-stop", onFailure: "stop" },
          plan: [{
            id: "capture-outcome",
            label: "Close the captured outcome",
            prompt: input.evidence.summary,
            resumePolicy: "safe",
            dependsOn: [],
            needsYou: null,
            requiredAuthority: null,
            estimatedCostCents: 1,
            estimatedUnits: 1,
          }],
        } satisfies OutcomeContract,
      };
    },
  };
}

function createJudgment(now: () => number): ContractualJudgment {
  return {
    async judge(input): Promise<unknown> {
      if (input.workIds.length === 0) return { color: "yellow", input: { inputKey: "missing-work", question: "Which canonical Work should close this outcome?", choices: [] } };
      if (now() > input.contract.deadline.at) return { color: "red", reason: "The Outcome Contract deadline has passed." };
      const estimatedCost = input.contract.plan.reduce((total, task) => total + task.estimatedCostCents, 0);
      const estimatedUnits = input.contract.plan.reduce((total, task) => total + task.estimatedUnits, 0);
      if (estimatedCost > input.contract.budget.maxCostCents || estimatedUnits > input.contract.budget.maxUnits) return { color: "red", reason: "The Contract budget cannot cover the planned Work." };
      if (input.evidence.length === 0) return { color: "yellow", input: { inputKey: "missing-evidence", question: "Provide the provenance-bearing evidence needed to run this outcome.", choices: [] } };
      if (input.evidence.some((evidence) => evidence.criterionIds.length === 0)) return { color: "red", reason: "Capture evidence does not cover a Contract criterion." };
      return { color: "green" };
    },
  };
}

function createIndependentVerifier(work: WorkLockStoreInterface): OutcomeVerifier {
  return {
    async verify(input): Promise<unknown> {
      if (input.workIds.length === 0) return { status: "not_verified", reason: "canonical_work_missing" };
      const obligations = input.workIds.map((workId) => work.getObligation(workId));
      if (obligations.some((obligation) => obligation === null || obligation.status !== "completed")) return { status: "not_verified", reason: "canonical_work_not_completed" };
      const evidence = obligations.flatMap((obligation) => obligation?.evidence ?? []);
      if (!evidence.some((item) => item.kind === "worker-batch")) return { status: "not_verified", reason: "independent_worker_evidence_missing" };
      return {
        status: "verified",
        contractId: input.contract.id,
        contractVersion: input.contract.version,
        criteriaHash: input.criteriaHash,
        traceIdentity: input.traceIdentity,
        evidenceRefs: input.evidence.map((item) => item.reference),
        artifactRefs: input.artifacts.map((item) => item.reference),
        usage: { costCents: 1, units: 1 },
      };
    },
  };
}

function defaultWorkerRunner(job: Readonly<WorkerJobRecord>): JsonValue {
  const promptHash = createHash("sha256").update(job.prompt, "utf8").digest("hex");
  return { kind: "bounded-worker-result", jobId: job.id, promptHash, completedAt: Date.now() } satisfies JsonObject;
}

function createCanonicalWorkStack(options: CentipedeV3RuntimeOptions, now: () => number): { readonly adapter: ExistingWorkOrchestrator; readonly work: WorkLockStoreInterface; readonly workerStore: WorkerJobStore; readonly recovery: Promise<unknown>; readonly close: () => void } {
  const work = createWorkLockStore({ file: join(options.dataDir, "work-lock-store.db"), now });
  const accounts = new AccountDirectory({ ownerId: "centipede-v3", store: new JsonFileAccountDirectoryStore(join(options.dataDir, "account-directory.json")) });
  const policy = new ActionPolicy({ file: join(options.dataDir, "action-policy.db"), now, defaultOwnerId: "shane" });
  const telemetry = new AutonomyTelemetry({ file: join(options.dataDir, "autonomy-telemetry.db"), now });
  const workerStore = createWorkerJobFileStore(join(options.dataDir, "worker-jobs.json"));
  const workers = createWorkerJobs({
    store: workerStore,
    now,
    run: options.workerRunner ?? defaultWorkerRunner,
    interrupt: async () => undefined,
  }, { concurrency: 1 });
  const orchestrator: WorkOrchestrator = createWorkOrchestrator({
    work,
    accounts,
    policy,
    telemetry,
    journalFile: join(options.dataDir, "work-orchestrator.json"),
    executor: { async execute() { throw new Error("V3 connector actions require a bound provider adapter"); } },
    verifier: { async verify() { return { status: "not_verified", reason: "V3 connector verification requires a fresh provider read" }; } },
    worker: {
      async dispatch(event, batchId) {
        const batch = await workers.launchBatch(event.taskId, event.tasks.map((task) => ({
          key: task.key,
          label: task.label,
          prompt: task.prompt,
          resumePolicy: task.resumePolicy,
          dependsOn: task.dependsOn,
          resourceLocks: task.resourceLocks,
          approvalGate: task.approvalGate,
          metadata: task.metadata,
        })), { id: batchId, label: event.title });
        return { batchId: batch.batchId, settled: batch.settled.then(() => undefined) };
      },
      async inspect(batchId, expectedTaskCount) {
        const jobs = (await workerStore.list()).filter((job) => job.batchId === batchId);
        if (jobs.length === 0) return { status: "missing" };
        if (jobs.length !== expectedTaskCount) return { status: "failed", reason: "worker batch is incomplete" };
        if (jobs.some((job) => job.status === "running")) return { status: "running" };
        if (jobs.some((job) => job.status === "queued")) return { status: "queued" };
        const failed = jobs.find((job) => job.status === "failed");
        if (failed) return { status: "failed", reason: failed.error ?? "worker failed" };
        const canceled = jobs.find((job) => job.status === "canceled");
        if (canceled) return { status: "canceled", reason: canceled.error ?? "worker canceled" };
        const recordedAt = Math.max(...jobs.map((job) => job.settledAt ?? job.createdAt));
        return { status: "completed", reference: `worker-batch:${batchId}`, summary: `${jobs.length} bounded worker completed.`, recordedAt };
      },
    },
    now,
  });
  return { adapter: orchestrator, work, workerStore, recovery: workers.recover(), close: () => { work.close(); policy.close(); telemetry.close(); } };
}

function graphForOutcome(graph: ContextGraph, outcome: OutcomeView, state: string): ContextGraph {
  const outcomeNodeId = `outcome:${outcome.contract.outcomeId}`;
  const nodes = [...graph.nodes];
  const outcomeNode: {
    id: string;
    type: "verified-outcome" | "outcome";
    contractId: string;
    contractVersion: number;
    receiptReference?: string;
  } = {
    id: outcomeNodeId,
    type: state === "completed" ? "verified-outcome" : "outcome",
    contractId: outcome.contract.id,
    contractVersion: outcome.contract.version,
  };
  if (outcome.receipt) outcomeNode.receiptReference = `receipt:${outcome.receipt.outcomeId}:v${outcome.receipt.contractVersion}`;
  const index = nodes.findIndex((node) => node.id === outcomeNodeId);
  if (index < 0) nodes.push(outcomeNode);
  else nodes[index] = { ...nodes[index], ...outcomeNode };
  return { nodes, edges: [...graph.edges] };
}

export function createCentipedeV3Runtime(options: CentipedeV3RuntimeOptions): CentipedeV3Runtime {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const now = options.now ?? Date.now;
  const graphFile = join(options.dataDir, graphFileName);
  let graph = loadGraph(graphFile);
  const canonical = createCanonicalWorkStack(options, now);
  const outcome: OutcomeOrchestrator = createOutcomeOrchestrator({
    journalFile: join(options.dataDir, "outcomes.ndjson"),
    work: canonical.adapter,
    verifier: createIndependentVerifier(canonical.work),
    captureInference: createCaptureInference(() => graph, canonical.work),
    judgment: createJudgment(now),
    learning: createExecutionLearning({ file: join(options.dataDir, "centipede-v3-learning.json") }),
    now,
  });

  function updateGraph(result: OutcomeCommandResult): void {
    if (!("view" in result) || result.view === undefined) return;
    const view = result.view;
    graph = graphForOutcome(graph, view, view.state);
    for (const evidence of view.evidence) {
      if (!evidence.evidenceId.startsWith("capture:")) continue;
      const captureId = evidence.evidenceId.slice("capture:".length);
      const captureNodeId = `capture:${captureId}`;
      if (!graph.nodes.some((node) => node.id === captureNodeId)) {
        graph = {
          ...graph,
          nodes: [...graph.nodes, {
            id: captureNodeId,
            type: "capture",
            provenance: { source: "capture", reference: evidence.reference, contentHash: evidence.contentHash, observedAt: evidence.recordedAt },
          }],
        };
      }
      const edge: ContextGraph["edges"][number] = { from: captureNodeId, to: `outcome:${view.contract.outcomeId}`, kind: "supports" };
      if (!graph.edges.some((candidate) => candidate.from === edge.from && candidate.to === edge.to && candidate.kind === edge.kind)) graph = { ...graph, edges: [...graph.edges, edge] };
    }
    if (view.state === "completed" && view.receipt) {
      const receiptId = `receipt:${view.receipt.outcomeId}:v${view.receipt.contractVersion}`;
      const learningId = `learning:${view.receipt.outcomeId}:v${view.receipt.contractVersion}`;
      const feedbackNodes: ContextGraph["nodes"] = [
        { id: receiptId, type: "receipt", contractId: view.receipt.contractId, contractVersion: view.receipt.contractVersion, receiptReference: receiptId },
        { id: learningId, type: "learning", contractId: view.receipt.contractId, contractVersion: view.receipt.contractVersion },
      ];
      graph = { ...graph, nodes: [...graph.nodes.filter((node) => !feedbackNodes.some((candidate) => candidate.id === node.id)), ...feedbackNodes] };
      const feedbackEdges: ContextGraph["edges"] = [
        { from: receiptId, to: `outcome:${view.contract.outcomeId}`, kind: "produced-by" },
        { from: learningId, to: receiptId, kind: "learned-from" },
      ];
      graph = { ...graph, edges: [...graph.edges.filter((edge) => !feedbackEdges.some((candidate) => candidate.from === edge.from && candidate.to === edge.to && candidate.kind === edge.kind)), ...feedbackEdges] };
    }
    saveGraph(graphFile, graph);
  }

  return {
    async dispatch(command: unknown): Promise<OutcomeCommandResult> {
      await canonical.recovery;
      const delta = captureContextDelta(command);
      if (delta) {
        graph = mergeCaptureContext(graph, delta);
        saveGraph(graphFile, graph);
      }
      const result = await outcome.dispatch(command);
      updateGraph(result);
      return result;
    },
    inspectContext(): ContextGraph { return graph; },
    inspectOutcome(outcomeId: string): OutcomeProjection | null {
      const inspected = outcome.inspect(outcomeId);
      return inspected.status === "available" ? projectOutcome(inspected.view) : null;
    },
    inspectOutcomeReceipt(outcomeId: string): OutcomeReceipt | null {
      const inspected = outcome.inspect(outcomeId);
      return inspected.status === "available" && inspected.view.state === "completed" ? inspected.view.receipt : null;
    },
    inspectCanonicalWork(outcomeId: string): readonly WorkObligation[] {
      const inspected = outcome.inspect(outcomeId);
      if (inspected.status !== "available") return [];
      return inspected.view.work.map((link) => canonical.work.getObligation(link.workId)).filter((obligation): obligation is WorkObligation => obligation !== null);
    },
    userContract(outcomeId: string, objective: string): OutcomeContract {
      return {
        id: `${outcomeId}:v1`,
        outcomeId,
        version: 1,
        ownerId: "shane",
        objective,
        constraints: [{ kind: "scope", statement: "Use only local reversible work." }],
        successCriteria: [{ id: "result", statement: "The user-stated result is independently verified." }],
        deadline: { at: now() + 86_400_000 },
        budget: { currency: "USD", maxCostCents: 100, maxUnits: 10 },
        qualityBar: "Exact Contract binding and independent verification",
        authority: { mode: "deny-by-default", grants: [] },
        escalation: { channel: "needs-you", on: ["missing-input", "authority-required"] },
        evidenceRequirements: { requiredCriterionIds: ["result"], requiredArtifactKinds: [] },
        rollback: { onCancel: "reversible-stop", onFailure: "stop" },
        plan: [{ id: "result", label: "Produce the result", prompt: objective, resumePolicy: "safe", dependsOn: [], needsYou: null, requiredAuthority: null, estimatedCostCents: 1, estimatedUnits: 1 }],
      };
    },
    workExecutionCount(): number {
      const jobs = canonical.workerStore.list();
      return Array.isArray(jobs) ? jobs.filter((job) => job.status === "completed").length : 0;
    },
    close(): void { canonical.close(); },
  };
}
