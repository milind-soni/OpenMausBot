import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ContractualJudgment,
  CaptureOutcomeInference,
  OutcomeJudgment,
  ExistingWorkOrchestrator,
  OutcomeContract,
  OutcomeEvidence,
  OutcomeVerifier,
} from "./outcome-orchestrator.ts";
import { createOutcomeOrchestrator, projectOutcome } from "./outcome-orchestrator.ts";
import type { OutcomeLearning, OutcomeRecord } from "./execution-learning.ts";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns,
 * anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening -- this fake
 * deliberately exercises the existing unknown V2 seam. */

class FakeWork implements ExistingWorkOrchestrator {
  readonly ingested = new Map<string, string>();
  readonly executions: string[] = [];
  reconcileStatus: "verified" | "awaiting_worker" | "not_verified" = "verified";
  executeStatus: "dispatched" | "ambiguous" = "dispatched";

  ingest(event: unknown): unknown {
    if (typeof event !== "object" || event === null || Array.isArray(event) || !("externalId" in event) || typeof event.externalId !== "string") return { status: "denied" };
    const existing = this.ingested.get(event.externalId);
    if (existing) return { status: "unchanged", workId: existing };
    const workId = `work-${this.ingested.size + 1}`;
    this.ingested.set(event.externalId, workId);
    return { status: "created", phase: "ingested", workId };
  }

  prepare(workId: string): unknown { return { status: "not_ready", workId }; }
  decide(input: unknown): unknown { return { status: "denied", input }; }

  async execute(workId: string): Promise<unknown> {
    this.executions.push(workId);
    return { status: this.executeStatus };
  }

  async reconcile(workId: string): Promise<unknown> {
    return { status: this.reconcileStatus, workId };
  }
}

class FakeVerifier implements OutcomeVerifier {
  stale = false;
  calls: number = 0;

  async verify(input: Parameters<OutcomeVerifier["verify"]>[0]): Promise<unknown> {
    this.calls += 1;
    return {
      status: "verified",
      contractId: this.stale ? "old-contract" : input.contract.id,
      contractVersion: input.contract.version,
      criteriaHash: input.criteriaHash,
      traceIdentity: input.traceIdentity,
      evidenceRefs: input.evidence.map((evidence) => evidence.reference),
      artifactRefs: input.artifacts.map((artifact) => artifact.reference),
      usage: { costCents: 2, units: 1 },
    };
  }
}

class FakeCaptureInference implements CaptureOutcomeInference {
  calls = 0;
  constructor(private readonly inferredContract: OutcomeContract = contract({
    id: "receipt-1:v1",
    outcomeId: "receipt-1",
    objective: "Collect the requested receipt",
    plan: [{ ...contract().plan[0], needsYou: null }],
  })) {}

  async infer(): Promise<unknown> {
    this.calls += 1;
    return {
      status: "inferred",
      contract: this.inferredContract,
    };
  }
}

class AmbiguousCaptureInference implements CaptureOutcomeInference {
  async infer(): Promise<unknown> {
    return { status: "ambiguous", reason: "The evidence could describe more than one outcome." };
  }
}

class FakeJudgment implements ContractualJudgment {
  readonly colors: string[] = [];
  constructor(private readonly verdict: OutcomeJudgment = { color: "green" }) {}

  async judge(): Promise<unknown> {
    this.colors.push(this.verdict.color);
    return this.verdict;
  }
}

class FakeLearning implements OutcomeLearning {
  readonly records: OutcomeRecord[] = [];

  record(record: OutcomeRecord): boolean {
    this.records.push(record);
    return true;
  }

  review(): null { return null; }

  chooseRoute(input: { readonly outcomeId: string; readonly taskId: string; readonly candidates: readonly string[] }): string | null {
    return input.candidates[1] ?? input.candidates[0] ?? null;
  }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function harness(options: { now?: () => number; inference?: CaptureOutcomeInference; judgment?: ContractualJudgment; learning?: OutcomeLearning } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "openmausbot-v3-outcome-"));
  temporaryDirectories.push(directory);
  const work = new FakeWork();
  const verifier = new FakeVerifier();
  const journalFile = join(directory, "outcomes.json");
  const create = () => createOutcomeOrchestrator({ journalFile, work, verifier, captureInference: options.inference, judgment: options.judgment, learning: options.learning, now: options.now });
  return { directory, journalFile, work, verifier, create };
}

function contract(overrides: Partial<OutcomeContract> = {}): OutcomeContract {
  return {
    id: "outcome-1:v1",
    outcomeId: "outcome-1",
    version: 1,
    ownerId: "shane",
    objective: "Produce the internal dogfood receipt",
    constraints: [{ kind: "scope", statement: "Use only local reversible work" }],
    successCriteria: [{ id: "receipt", statement: "A receipt names the verified artifact" }],
    deadline: { at: 2_000 },
    budget: { currency: "USD", maxCostCents: 10, maxUnits: 4 },
    qualityBar: "Exact contract binding and independently checked evidence",
    authority: { mode: "deny-by-default", grants: [] },
    escalation: { channel: "needs-you", on: ["missing-input", "authority-required"] },
    evidenceRequirements: { requiredCriterionIds: ["receipt"], requiredArtifactKinds: ["receipt"] },
    rollback: { onCancel: "reversible-stop", onFailure: "stop" },
    plan: [{ id: "produce", label: "Produce receipt", prompt: "Write the local receipt", resumePolicy: "never", dependsOn: [], needsYou: { inputKey: "quality", question: "Which quality bar should the dogfood receipt use?", choices: ["Exact", "Concise"] }, requiredAuthority: null, estimatedCostCents: 2, estimatedUnits: 1 }],
    ...overrides,
  };
}

function evidence(): OutcomeEvidence {
  return {
    outcomeId: "outcome-1",
    contractVersion: 1,
    evidenceId: "evidence-1",
    reference: "local:receipt-1",
    summary: "The local dogfood artifact contains the requested receipt.",
    contentHash: "a".repeat(64),
    criterionIds: ["receipt"],
    artifacts: [{ reference: "local:artifact-1", kind: "receipt", contentHash: "b".repeat(64) }],
    recordedAt: 1_000,
  };
}

describe("OutcomeOrchestrator", () => {
  it("infers a high-confidence Capture into a canonical outcome through contractual judgment", async () => {
    const judgment = new FakeJudgment();
    const h = harness({ now: () => 1_000, inference: new FakeCaptureInference(), judgment });
    const orchestrator = h.create();
    await expect(orchestrator.dispatch({
      kind: "capture",
      evidence: {
        captureId: "capture-1",
        source: "gmail",
        reference: "gmail:message-1",
        summary: "The requested receipt is ready to collect.",
        contentHash: "c".repeat(64),
        confidence: "high",
        criterionIds: ["receipt"],
        artifacts: [{ reference: "gmail:receipt-1", kind: "receipt", contentHash: "d".repeat(64) }],
        observedAt: 1_000,
      },
    })).resolves.toMatchObject({
      status: "ok",
      view: { state: "running", contract: { outcomeId: "receipt-1" }, work: [{ status: "verified" }] },
    });
    expect(judgment.colors).toEqual(["green"]);
    expect(h.work.executions).toEqual(["work-1"]);
  });

  it("deduplicates replayed Capture evidence and links it to the existing outcome", async () => {
    const inference = new FakeCaptureInference();
    const judgment = new FakeJudgment();
    const h = harness({ now: () => 1_000, inference, judgment });
    const capture = {
      kind: "capture",
      evidence: {
        captureId: "capture-replayed",
        source: "gmail",
        reference: "gmail:message-replayed",
        summary: "The requested receipt is ready to collect.",
        contentHash: "e".repeat(64),
        confidence: "high",
        criterionIds: ["receipt"],
        artifacts: [{ reference: "gmail:receipt-replayed", kind: "receipt", contentHash: "f".repeat(64) }],
        observedAt: 1_000,
      },
    };
    const orchestrator = h.create();
    await expect(orchestrator.dispatch(capture)).resolves.toMatchObject({ status: "ok", view: { contract: { outcomeId: "receipt-1" } } });
    await expect(orchestrator.dispatch(capture)).resolves.toMatchObject({ status: "ok", view: { contract: { outcomeId: "receipt-1" }, evidence: [{ evidenceId: "capture:capture-replayed" }] } });
    const restarted = h.create();
    await expect(restarted.dispatch(capture)).resolves.toMatchObject({ status: "ok", view: { contract: { outcomeId: "receipt-1" } } });
    const inspected = restarted.inspect("receipt-1");
    if (inspected.status !== "available") throw new Error("expected the inferred outcome after replay");
    expect(inspected.view.evidence).toHaveLength(1);
    expect(inference.calls).toBe(1);
    expect(judgment.colors).toEqual(["green"]);
    expect(h.work.executions).toEqual(["work-1"]);
  });

  it("keeps a yellow Capture as durable Needs-you input without executing Work", async () => {
    const judgment = new FakeJudgment({ color: "yellow", input: { inputKey: "recipient", question: "Which recipient should receive the receipt?", choices: ["Shane", "Team"] } });
    const h = harness({ now: () => 1_000, inference: new FakeCaptureInference(), judgment });
    const orchestrator = h.create();
    await expect(orchestrator.dispatch({
      kind: "capture",
      evidence: {
        captureId: "capture-yellow",
        source: "gmail",
        reference: "gmail:message-yellow",
        summary: "A receipt is ready, but its recipient is unclear.",
        contentHash: "1".repeat(64),
        confidence: "high",
        criterionIds: ["receipt"],
        artifacts: [{ reference: "gmail:receipt-yellow", kind: "receipt", contentHash: "2".repeat(64) }],
        observedAt: 1_000,
      },
    })).resolves.toMatchObject({ status: "needs_you", view: { state: "needs-you" }, input: { inputKey: "recipient" } });
    expect(h.work.executions).toEqual([]);
    const restarted = h.create();
    expect(restarted.inspect("receipt-1")).toMatchObject({ status: "available", view: { state: "needs-you", judgment: { color: "yellow" } } });
    await expect(restarted.dispatch({ kind: "answer-needs-you", outcomeId: "receipt-1", contractVersion: 1, inputKey: "recipient", answer: "Shane", answeredBy: "Shane" })).resolves.toMatchObject({ status: "ok", view: { state: "running" } });
    expect(h.work.executions).toEqual([]);
  });

  it("parks a red Capture judgment and never executes Work", async () => {
    const judgment = new FakeJudgment({ color: "red", reason: "The inferred action is outside the contract authority." });
    const h = harness({ now: () => 1_000, inference: new FakeCaptureInference(), judgment });
    const orchestrator = h.create();
    await expect(orchestrator.dispatch({
      kind: "capture",
      evidence: {
        captureId: "capture-red",
        source: "gmail",
        reference: "gmail:message-red",
        summary: "A receipt suggests an action outside the allowed scope.",
        contentHash: "3".repeat(64),
        confidence: "high",
        criterionIds: ["receipt"],
        artifacts: [{ reference: "gmail:receipt-red", kind: "receipt", contentHash: "4".repeat(64) }],
        observedAt: 1_000,
      },
    })).resolves.toMatchObject({ status: "blocked", reason: "judgment_red", view: { state: "running", judgment: { color: "red" } } });
    expect(h.work.executions).toEqual([]);
    const restarted = h.create();
    expect(restarted.inspect("receipt-1")).toMatchObject({ status: "available", view: { state: "running", judgment: { color: "red", reason: "The inferred action is outside the contract authority." } } });
  });

  it("does not let green bypass a missing contract authority grant", async () => {
    const inferredContract = contract({
      id: "restricted-1:v1",
      outcomeId: "restricted-1",
      plan: [{ ...contract().plan[0], needsYou: null, requiredAuthority: { action: "publish", target: "prod", scope: "release", expiresAt: 2_000 } }],
    });
    const h = harness({ now: () => 1_000, inference: new FakeCaptureInference(inferredContract), judgment: new FakeJudgment() });
    await expect(h.create().dispatch({
      kind: "capture",
      evidence: {
        captureId: "capture-authority",
        source: "gmail",
        reference: "gmail:message-authority",
        summary: "A receipt suggests publishing to production.",
        contentHash: "5".repeat(64),
        confidence: "high",
        criterionIds: ["receipt"],
        artifacts: [{ reference: "gmail:receipt-authority", kind: "receipt", contentHash: "6".repeat(64) }],
        observedAt: 1_000,
      },
    })).resolves.toMatchObject({ status: "blocked", reason: "authority_denied", view: { state: "failed", judgment: { color: "green" } } });
    expect(h.work.executions).toEqual([]);
  });

  it("fails ambiguous Capture safely without inventing an outcome or asking Shane", async () => {
    const judgment = new FakeJudgment();
    const h = harness({ now: () => 1_000, inference: new AmbiguousCaptureInference(), judgment });
    await expect(h.create().dispatch({
      kind: "capture",
      evidence: {
        captureId: "capture-ambiguous",
        source: "gmail",
        reference: "gmail:message-ambiguous",
        summary: "Several unrelated threads mention a receipt.",
        contentHash: "7".repeat(64),
        confidence: "high",
        criterionIds: ["receipt"],
        artifacts: [{ reference: "gmail:receipt-ambiguous", kind: "receipt", contentHash: "8".repeat(64) }],
        observedAt: 1_000,
      },
    })).resolves.toEqual({ status: "blocked", reason: "capture_ambiguous" });
    expect(h.create().inspect("receipt-1")).toEqual({ status: "missing" });
    expect(judgment.colors).toEqual([]);
    expect(h.work.executions).toEqual([]);
  });

  it("creates, accepts, pauses, resumes, executes, verifies, and replays one outcome", async () => {
    const h = harness({ now: () => 1_000 });
    const first = h.create();
    await expect(first.dispatch({ kind: "declare", contract: contract() })).resolves.toMatchObject({ status: "ok", view: { state: "declared" } });
    await expect(first.dispatch({ kind: "accept", outcomeId: "outcome-1", contractVersion: 2 })).resolves.toMatchObject({ status: "denied", reason: "contract_version_mismatch_or_missing" });
    await expect(first.dispatch({ kind: "accept", outcomeId: "outcome-1", contractVersion: 1 })).resolves.toMatchObject({ status: "ok", view: { state: "accepted", work: [{ workId: "work-1" }] } });

    const restarted = h.create();
    await expect(restarted.dispatch({ kind: "run", outcomeId: "outcome-1", contractVersion: 1 })).resolves.toMatchObject({ status: "needs_you", input: { inputKey: "quality" } });
    await expect(restarted.dispatch({ kind: "answer-needs-you", outcomeId: "outcome-1", contractVersion: 1, inputKey: "quality", answer: "password=never-store-this", answeredBy: "Shane" })).resolves.toMatchObject({ status: "ok", view: { state: "running" } });
    expect(readFileSync(h.journalFile, "utf8")).not.toContain("never-store-this");
    await expect(restarted.dispatch({ kind: "run", outcomeId: "outcome-1", contractVersion: 1 })).resolves.toMatchObject({ status: "ok", view: { state: "running", work: [{ status: "verified" }] } });
    await expect(restarted.dispatch({ kind: "record-evidence", evidence: evidence() })).resolves.toMatchObject({ status: "ok" });
    const verified = await restarted.dispatch({ kind: "verify", outcomeId: "outcome-1", contractVersion: 1 });
    expect(verified).toMatchObject({ status: "ok", view: { state: "completed", receipt: { kind: "outcome-completed", contractVersion: 1 } } });
    if (verified.status !== "ok" || !verified.receipt) throw new Error("expected a verified receipt");
    expect(verified.receipt.record.links).toMatchObject({ contractId: "outcome-1:v1", contractVersion: 1, workIds: ["work-1"], evidenceIds: ["evidence-1"] });
    expect(verified.receipt.record.executionTrace.complete).toBe(true);
    expect(verified.receipt.record.executionTrace.traceIdentity).toBe(verified.receipt.record.verifiedOutput.traceIdentity);
    expect(verified.receipt.record.executionTrace.traceIdentity).toBe(verified.receipt.record.retrospective.traceIdentity);
    expect(verified.receipt.record.retrospective.metrics.find((metric) => metric.name === "aws")?.value.status).toBe("unknown");

    const replayed = h.create();
    expect(replayed.inspect("outcome-1")).toMatchObject({ status: "available", view: { state: "completed" } });
    const inspected = replayed.inspect("outcome-1");
    if (inspected.status !== "available" || inspected.view.state !== "completed") throw new Error("expected the completed receipt after restart");
    expect(inspected.view.receipt).toEqual(verified.receipt);
    await expect(replayed.dispatch({ kind: "verify", outcomeId: "outcome-1", contractVersion: 1 })).resolves.toMatchObject({ status: "denied", reason: "outcome_not_ready" });
    expect(h.work.executions).toEqual(["work-1"]);
    expect(h.verifier.calls).toBe(1);
  });

  it("rejects stale or conflicting evidence and stale verifier output", async () => {
    const h = harness({ now: () => 1_000 });
    const orchestrator = h.create();
    await orchestrator.dispatch({ kind: "declare", contract: contract({ plan: [{ ...contract().plan[0], needsYou: null }] }) });
    await orchestrator.dispatch({ kind: "accept", outcomeId: "outcome-1", contractVersion: 1 });
    await orchestrator.dispatch({ kind: "run", outcomeId: "outcome-1", contractVersion: 1 });
    await orchestrator.dispatch({ kind: "record-evidence", evidence: evidence() });
    await expect(orchestrator.dispatch({ kind: "record-evidence", evidence: { ...evidence(), summary: "conflicting" } })).resolves.toMatchObject({ status: "denied", reason: "evidence_conflict" });
    h.verifier.stale = true;
    await expect(orchestrator.dispatch({ kind: "verify", outcomeId: "outcome-1", contractVersion: 1 })).resolves.toMatchObject({ status: "blocked", reason: "stale_verifier" });
    expect(orchestrator.inspect("outcome-1")).toMatchObject({ status: "available", view: { state: "verifying" } });
  });

  it("fails closed for authority, budget, deadline, partial work, and ambiguous execution", async () => {
    const authority = harness({ now: () => 1_000 });
    const restricted = authority.create();
    const restrictedContract = contract({ plan: [{ ...contract().plan[0], needsYou: null, requiredAuthority: { action: "publish", target: "prod", scope: "release", expiresAt: 2_000 } }] });
    await restricted.dispatch({ kind: "declare", contract: restrictedContract });
    await restricted.dispatch({ kind: "accept", outcomeId: "outcome-1", contractVersion: 1 });
    await expect(restricted.dispatch({ kind: "run", outcomeId: "outcome-1", contractVersion: 1 })).resolves.toMatchObject({ status: "blocked", reason: "authority_denied" });

    const budget = harness({ now: () => 1_000 });
    const overBudget = budget.create();
    await overBudget.dispatch({ kind: "declare", contract: contract({ budget: { currency: "USD", maxCostCents: 1, maxUnits: 1 }, plan: [{ ...contract().plan[0], needsYou: null }] }) });
    await overBudget.dispatch({ kind: "accept", outcomeId: "outcome-1", contractVersion: 1 });
    await expect(overBudget.dispatch({ kind: "run", outcomeId: "outcome-1", contractVersion: 1 })).resolves.toMatchObject({ status: "blocked", reason: "budget_breached" });

    const deadline = harness({ now: () => 3_000 });
    const expired = deadline.create();
    await expired.dispatch({ kind: "declare", contract: contract({ plan: [{ ...contract().plan[0], needsYou: null }] }) });
    await expired.dispatch({ kind: "accept", outcomeId: "outcome-1", contractVersion: 1 });
    await expect(expired.dispatch({ kind: "run", outcomeId: "outcome-1", contractVersion: 1 })).resolves.toMatchObject({ status: "blocked", reason: "deadline_breached" });

    const partial = harness({ now: () => 1_000 });
    const partialOrchestrator = partial.create();
    const twoTasks = contract({ plan: [
      { ...contract().plan[0], needsYou: null },
      { ...contract().plan[0], id: "second", label: "Second", needsYou: null },
    ] });
    await partialOrchestrator.dispatch({ kind: "declare", contract: twoTasks });
    await partialOrchestrator.dispatch({ kind: "accept", outcomeId: "outcome-1", contractVersion: 1 });
    partial.work.reconcileStatus = "not_verified";
    await expect(partialOrchestrator.dispatch({ kind: "run", outcomeId: "outcome-1", contractVersion: 1 })).resolves.toMatchObject({ status: "blocked", reason: "work_not_verified" });

    const ambiguous = harness({ now: () => 1_000 });
    const ambiguousOrchestrator = ambiguous.create();
    await ambiguousOrchestrator.dispatch({ kind: "declare", contract: contract({ plan: [{ ...contract().plan[0], needsYou: null }] }) });
    await ambiguousOrchestrator.dispatch({ kind: "accept", outcomeId: "outcome-1", contractVersion: 1 });
    ambiguous.work.executeStatus = "ambiguous";
    await expect(ambiguousOrchestrator.dispatch({ kind: "run", outcomeId: "outcome-1", contractVersion: 1 })).resolves.toMatchObject({ status: "blocked", reason: "work_execution_ambiguous" });
    const replacement = ambiguous.create();
    await expect(replacement.dispatch({ kind: "run", outcomeId: "outcome-1", contractVersion: 1 })).resolves.toMatchObject({ status: "blocked", reason: "work_execution_ambiguous" });
    expect(ambiguous.work.executions).toEqual(["work-1"]);
  });

  it("persists rollback/cancellation and refuses corrupt or missing journals", async () => {
    const h = harness({ now: () => 1_000 });
    const orchestrator = h.create();
    await orchestrator.dispatch({ kind: "declare", contract: contract() });
    await orchestrator.dispatch({ kind: "accept", outcomeId: "outcome-1", contractVersion: 1 });
    await expect(orchestrator.dispatch({ kind: "cancel", outcomeId: "outcome-1", contractVersion: 1, reason: "Stop the dogfood" })).resolves.toMatchObject({ status: "ok", view: { state: "rolled_back" } });
    const restarted = h.create();
    expect(restarted.inspect("outcome-1")).toMatchObject({ status: "available", view: { state: "rolled_back" } });

    const missing = harness({ now: () => 1_000 });
    const missingFirst = missing.create();
    await missingFirst.dispatch({ kind: "declare", contract: contract({ outcomeId: "missing-journal", id: "missing-journal:v1" }) });
    await missingFirst.dispatch({ kind: "accept", outcomeId: "missing-journal", contractVersion: 1 });
    rmSync(missing.journalFile);
    const missingRestart = missing.create();
    expect(missingRestart.inspect("missing-journal")).toEqual({ status: "missing" });
    await expect(missingRestart.dispatch({ kind: "run", outcomeId: "missing-journal", contractVersion: 1 })).resolves.toMatchObject({ status: "denied", reason: "outcome_not_ready" });
    expect(missing.work.executions).toEqual([]);

    writeFileSync(h.journalFile, "{corrupt", "utf8");
    const corrupt = h.create();
    await expect(corrupt.dispatch({ kind: "declare", contract: contract({ outcomeId: "outcome-2", id: "outcome-2:v1" }) })).resolves.toMatchObject({ status: "unavailable", reason: "journal_unavailable" });
    expect(corrupt.inspect("outcome-1")).toEqual({ status: "unavailable" });
  });

  it("keeps a long trace complete and does not learn from unverified work", async () => {
    const learning = new FakeLearning();
    const h = harness({ now: () => 1_000, learning });
    const orchestrator = h.create();
    const template = contract().plan[0];
    if (!template) throw new Error("expected a plan template");
    const manyTasks = Array.from({ length: 18 }, (_, index) => ({ ...template, id: `task-${index}`, label: `Task ${index}`, needsYou: null }));
    await orchestrator.dispatch({ kind: "declare", contract: contract({ budget: { currency: "USD", maxCostCents: 100, maxUnits: 40 }, plan: manyTasks }) });
    await orchestrator.dispatch({ kind: "accept", outcomeId: "outcome-1", contractVersion: 1 });
    await orchestrator.dispatch({ kind: "run", outcomeId: "outcome-1", contractVersion: 1 });
    await orchestrator.dispatch({ kind: "record-evidence", evidence: evidence() });
    const verified = await orchestrator.dispatch({ kind: "verify", outcomeId: "outcome-1", contractVersion: 1 });
    expect(verified).toMatchObject({ status: "ok", view: { state: "completed" } });
    if (verified.status !== "ok" || !verified.receipt) throw new Error("expected the long outcome to complete");
    expect(verified.receipt.record.executionTrace.entries.length).toBeGreaterThanOrEqual(60);
    expect(verified.receipt.record.executionTrace.entries.at(-1)?.action).toBe("outcome-completed");
    expect(learning.records).toHaveLength(1);

    const failedLearning = new FakeLearning();
    const failed = harness({ now: () => 1_000, learning: failedLearning });
    const failedOrchestrator = failed.create();
    await failedOrchestrator.dispatch({ kind: "declare", contract: contract({ plan: [{ ...template, needsYou: null }] }) });
    await failedOrchestrator.dispatch({ kind: "accept", outcomeId: "outcome-1", contractVersion: 1 });
    failed.work.reconcileStatus = "not_verified";
    await expect(failedOrchestrator.dispatch({ kind: "run", outcomeId: "outcome-1", contractVersion: 1 })).resolves.toMatchObject({ status: "blocked", reason: "work_not_verified" });
    expect(failedLearning.records).toHaveLength(0);
  });

  it("projects one quiet outcome-first row for the right rail and chat", async () => {
    const h = harness({ now: () => 1_000 });
    const orchestrator = h.create();
    await orchestrator.dispatch({ kind: "declare", contract: contract() });
    await orchestrator.dispatch({ kind: "accept", outcomeId: "outcome-1", contractVersion: 1 });
    const inspected = orchestrator.inspect("outcome-1");
    if (inspected.status !== "available") throw new Error("expected an available outcome");
    expect(projectOutcome(inspected.view)).toEqual({
      outcomeId: "outcome-1",
      title: "Produce the internal dogfood receipt",
      state: "accepted",
      quiet: true,
      work: [{ workId: "work-1", label: "Produce receipt", state: "planned" }],
      chatSummary: "Produce the internal dogfood receipt · accepted",
    });
  });
});
