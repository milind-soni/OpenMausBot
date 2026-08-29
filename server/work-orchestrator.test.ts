import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AccountDirectory } from "./account-directory.ts";
import { ActionPolicy } from "./action-policy.ts";
import { AutonomyTelemetry } from "./autonomy-telemetry.ts";
import { WorkLockStore } from "./work-lock-store.ts";
import {
  createWorkOrchestrator,
  type WorkActionExecutor,
  type WorkActionVerifier,
  type WorkWorkerExecutor,
  type WorkWorkerStatus,
} from "./work-orchestrator.ts";

const directories: string[] = [];

interface HarnessOptions {
  execution?: "final" | "handoff" | "throw";
  accounts?: ReadonlyArray<{ identity: string; accountId: string }>;
}

function harness(options: HarnessOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "omb-work-orchestrator-"));
  directories.push(directory);
  let now = new Date("2026-08-28T14:00:00.000Z").getTime();
  const work = new WorkLockStore({ file: join(directory, "work.db"), now: () => now });
  const policy = new ActionPolicy({ file: join(directory, "policy.db"), now: () => now });
  const accounts = new AccountDirectory({ ownerId: "owner-1" });
  for (const binding of options.accounts ?? [{ identity: "SEF", accountId: "ca_sef" }]) {
    accounts.register({
      ownerId: "owner-1",
      identity: binding.identity,
      provider: "gmail",
      accountId: binding.accountId,
      source: "connected-app",
      sourceId: `source-${binding.accountId}`,
      evidenceRef: `inventory:${binding.accountId}`,
    });
  }
  const telemetry = new AutonomyTelemetry({ file: join(directory, "telemetry.db"), now: () => now });
  const executionCalls: string[] = [];
  const verificationCalls: string[] = [];
  const workerDispatches: string[] = [];
  const workerInspections: Array<{ batchId: string; expectedTaskCount: number }> = [];
  let workerStatus: WorkWorkerStatus = { status: "running" };
  const worker: WorkWorkerExecutor = {
    async dispatch(event, batchId) {
      workerDispatches.push(`${event.taskId}:${batchId}`);
      return { batchId, settled: new Promise<void>(() => undefined) };
    },
    inspect(batchId, expectedTaskCount) {
      workerInspections.push({ batchId, expectedTaskCount });
      return workerStatus;
    },
  };
  const executor: WorkActionExecutor = {
    async execute(proposal) {
      executionCalls.push(proposal.proposalHash);
      if (options.execution === "throw") throw new Error("synthetic ambiguous provider boundary");
      if (options.execution === "handoff") {
        return { kind: "handoff", reference: `handoff:${proposal.id}` };
      }
      return {
        kind: "final",
        receipt: {
          ok: true,
          reference: `fake:gmail-draft:${proposal.proposalHash}`,
          observedAt: now,
        },
      };
    },
  };
  const verifier: WorkActionVerifier = {
    async verify(proposal, receipt) {
      verificationCalls.push(`${proposal.proposalHash}:${receipt.reference}`);
      return {
        status: "verified",
        evidence: {
          kind: "independent-verification",
          reference: `fake:mailbox:${proposal.proposalHash}`,
          summary: "The fake mailbox contains the exact draft once.",
          recordedAt: now,
        },
      };
    },
  };
  const journalFile = join(directory, "orchestrator.json");
  const create = () => createWorkOrchestrator({
    work,
    accounts,
    policy,
    telemetry,
    executor,
    verifier,
    worker,
    journalFile,
    now: () => now,
  });
  return {
    accounts,
    create,
    executionCalls,
    journalFile,
    policy,
    setNow(value: number) { now = value; },
    telemetry,
    verificationCalls,
    workerDispatches,
    workerInspections,
    setWorkerStatus(status: WorkWorkerStatus) { workerStatus = status; },
    work,
  };
}

function gmailDraftEvent(accountId = "ca_sef") {
  return {
    type: "action",
    source: "connector",
    externalId: "gmail-draft-1",
    title: "Draft the exact follow-up",
    ownerId: "owner-1",
    ownerLabel: "Chief",
    identity: "SEF",
    provider: "gmail",
    toolName: "GMAIL_CREATE_EMAIL_DRAFT",
    arguments: {
      account_id: accountId,
      recipient_email: "recipient@example.com",
      subject: "Exact subject",
      body: "Exact body",
    },
    requestedBy: "Chief",
    workScope: "aws",
  };
}

function workerBatchEvent() {
  return {
    type: "worker-batch",
    source: "parallelize-work",
    externalId: "worker-request-1",
    title: "Investigate two independent questions",
    ownerId: "owner-1",
    taskId: "thread-chief-1",
    tasks: [
      {
        label: "Audit",
        prompt: "Audit the local implementation and return evidence.",
        resumePolicy: "safe",
        metadata: { mode: "coordinate" },
      },
      {
        label: "Review",
        prompt: "Review the result without changing files.",
        resumePolicy: "never",
        metadata: { mode: "execute" },
      },
    ],
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("WorkOrchestrator", () => {
  it("dispatches task-scoped workers through canonical Work and verifies their durable terminal projection", async () => {
    const h = harness();
    const orchestrator = h.create();

    expect(Object.keys(orchestrator).sort()).toEqual(["decide", "execute", "ingest", "prepare", "reconcile"]);
    expect(orchestrator.ingest({ ...workerBatchEvent(), tasks: [{ label: "Invalid", prompt: "" }] })).toEqual({
      status: "denied",
      reason: "invalid_work_event",
    });
    const ingested = orchestrator.ingest(workerBatchEvent());
    expect(ingested).toMatchObject({ status: "created", phase: "ingested" });
    if (!("workId" in ingested)) throw new Error("worker work was not created");
    expect(orchestrator.ingest({ ...workerBatchEvent(), title: "Different work under the same request key" })).toEqual({
      status: "denied",
      reason: "worker_event_conflict",
    });

    expect(orchestrator.prepare(ingested.workId)).toMatchObject({
      status: "not_ready",
      reason: "worker_work_does_not_require_preparation",
    });
    await expect(orchestrator.execute(ingested.workId)).resolves.toEqual({
      status: "dispatched",
      phase: "dispatched",
      workId: ingested.workId,
    });
    expect(h.workerDispatches).toEqual([`thread-chief-1:${ingested.workId}`]);
    await expect(orchestrator.reconcile(ingested.workId)).resolves.toEqual({
      status: "awaiting_worker",
      phase: "dispatched",
      workId: ingested.workId,
    });
    expect(h.workerInspections).toEqual([{ batchId: ingested.workId, expectedTaskCount: 2 }]);

    h.setWorkerStatus({
      status: "completed",
      reference: `worker-batch:${ingested.workId}`,
      summary: "Two task-scoped workers completed.",
      recordedAt: new Date("2026-08-28T14:01:00.000Z").getTime(),
    });
    await expect(orchestrator.reconcile(ingested.workId)).resolves.toEqual({
      status: "verified",
      phase: "verified",
      workId: ingested.workId,
    });
    expect(h.work.getObligation(ingested.workId)).toMatchObject({
      status: "completed",
      metadata: { kind: "worker-batch", taskId: "thread-chief-1", taskCount: 2 },
      evidence: [{
        kind: "worker-batch",
        reference: `worker-batch:${ingested.workId}`,
        summary: "Two task-scoped workers completed.",
      }],
    });
    await expect(orchestrator.execute(ingested.workId)).resolves.toMatchObject({ status: "replay_prevented" });
    expect(h.workerDispatches).toHaveLength(1);

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("reports an interrupted worker batch after restart without dispatching it twice", async () => {
    const h = harness();
    const first = h.create();
    const ingested = first.ingest(workerBatchEvent());
    if (!("workId" in ingested)) throw new Error("worker work was not created");
    await expect(first.execute(ingested.workId)).resolves.toMatchObject({ status: "dispatched" });

    h.setWorkerStatus({ status: "failed", reason: "interrupted by restart; not replayed" });
    const restarted = h.create();
    await expect(restarted.execute(ingested.workId)).resolves.toMatchObject({
      status: "replay_prevented",
      phase: "dispatched",
    });
    await expect(restarted.reconcile(ingested.workId)).resolves.toEqual({
      status: "not_verified",
      reason: "interrupted by restart; not replayed",
      workId: ingested.workId,
    });
    expect(h.workerDispatches).toHaveLength(1);

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("executes an exact approved payload once and completes only after independent verification", async () => {
    const h = harness();
    const orchestrator = h.create();
    const ingested = orchestrator.ingest(gmailDraftEvent());
    expect(ingested).toMatchObject({ status: "created", phase: "ingested" });
    if (!("workId" in ingested)) throw new Error("expected a work id");

    const prepared = orchestrator.prepare(ingested.workId);
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("expected a prepared action");
    expect(prepared.proposal).toMatchObject({
      operation: "gmail.drafts.create",
      accountId: "ca_sef",
      payload: {
        recipient_email: "recipient@example.com",
        subject: "Exact subject",
        body: "Exact body",
      },
    });

    const decided = orchestrator.decide({
      workId: ingested.workId,
      approvalId: prepared.approvalId,
      proposalId: prepared.proposal.id,
      proposalHash: prepared.proposal.proposalHash,
      payloadHash: prepared.proposal.payloadHash,
      accountId: prepared.proposal.accountId,
      decision: "approved",
      decidedBy: "Shane",
      evidenceRef: "approval:test:exact",
    });
    expect(decided).toMatchObject({ status: "approved", phase: "approved" });

    await expect(orchestrator.execute(ingested.workId)).resolves.toMatchObject({ status: "executed", phase: "executed" });
    await expect(orchestrator.execute(ingested.workId)).resolves.toMatchObject({ status: "replay_prevented" });
    await expect(orchestrator.reconcile(ingested.workId)).resolves.toMatchObject({ status: "verified", phase: "verified" });
    expect(h.executionCalls).toHaveLength(1);
    expect(h.verificationCalls).toHaveLength(1);
    expect(h.work.getObligation(ingested.workId)?.status).toBe("completed");
    expect(h.telemetry.summary()).toMatchObject({
      observedWorkCount: 1,
      closedWorkCount: 1,
      verifiedOutcomeCount: 1,
      approvalRequestCount: 1,
      humanApprovalDecisionCount: 1,
    });

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("rejects a decision whose account or payload proof differs from the prepared proposal", () => {
    const h = harness();
    const orchestrator = h.create();
    const ingested = orchestrator.ingest(gmailDraftEvent());
    if (!("workId" in ingested)) throw new Error("expected a work id");
    const prepared = orchestrator.prepare(ingested.workId);
    if (prepared.status !== "prepared") throw new Error("expected a prepared action");

    expect(orchestrator.decide({
      workId: ingested.workId,
      approvalId: prepared.approvalId,
      proposalId: prepared.proposal.id,
      proposalHash: prepared.proposal.proposalHash,
      payloadHash: `${prepared.proposal.payloadHash.slice(0, -1)}0`,
      accountId: "ca_personal",
      decision: "approved",
      decidedBy: "Shane",
      evidenceRef: "approval:test:modified",
    })).toMatchObject({ status: "denied", reason: "decision_mismatch" });
    expect(h.work.getObligation(ingested.workId)?.approvals[0]?.status).toBe("pending");
    expect(h.executionCalls).toEqual([]);

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("blocks canonical work when the user rejects its exact prepared action", async () => {
    const h = harness();
    const orchestrator = h.create();
    const ingested = orchestrator.ingest(gmailDraftEvent());
    if (!("workId" in ingested)) throw new Error("expected a work id");
    const prepared = orchestrator.prepare(ingested.workId);
    if (prepared.status !== "prepared") throw new Error("expected a prepared action");

    expect(orchestrator.decide({
      workId: ingested.workId,
      approvalId: prepared.approvalId,
      proposalId: prepared.proposal.id,
      proposalHash: prepared.proposal.proposalHash,
      payloadHash: prepared.proposal.payloadHash,
      accountId: prepared.proposal.accountId,
      decision: "rejected",
      decidedBy: "fixture-reviewer",
      evidenceRef: "approval:fixture:rejected",
    })).toMatchObject({ status: "rejected", phase: "rejected" });
    expect(h.work.getObligation(ingested.workId)).toMatchObject({ status: "blocked" });
    await expect(orchestrator.execute(ingested.workId)).resolves.toMatchObject({
      status: "replay_prevented",
      phase: "rejected",
    });
    expect(h.executionCalls).toEqual([]);

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("blocks an action when its exact provider account is not bound to the selected identity", async () => {
    const h = harness();
    const orchestrator = h.create();
    const ingested = orchestrator.ingest(gmailDraftEvent("ca_personal"));
    if (!("workId" in ingested)) throw new Error("expected a work id");

    expect(orchestrator.prepare(ingested.workId)).toMatchObject({
      status: "blocked",
      reason: "account_not_resolved",
    });
    await expect(orchestrator.execute(ingested.workId)).resolves.toMatchObject({ status: "not_ready" });
    expect(h.executionCalls).toEqual([]);

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("persists a provider handoff before returning and never dispatches it again after restart", async () => {
    const h = harness({ execution: "handoff" });
    const first = h.create();
    const ingested = first.ingest(gmailDraftEvent());
    if (!("workId" in ingested)) throw new Error("expected a work id");
    const prepared = first.prepare(ingested.workId);
    if (prepared.status !== "prepared") throw new Error("expected a prepared action");
    first.decide({
      workId: ingested.workId,
      approvalId: prepared.approvalId,
      proposalId: prepared.proposal.id,
      proposalHash: prepared.proposal.proposalHash,
      payloadHash: prepared.proposal.payloadHash,
      accountId: prepared.proposal.accountId,
      decision: "approved",
      decidedBy: "Shane",
      evidenceRef: "approval:test:handoff",
    });
    await expect(first.execute(ingested.workId)).resolves.toMatchObject({ status: "dispatched", phase: "dispatched" });

    const restarted = h.create();
    await expect(restarted.execute(ingested.workId)).resolves.toMatchObject({ status: "replay_prevented", phase: "dispatched" });
    expect(h.executionCalls).toHaveLength(1);
    expect(restarted.ingest({
      type: "execution-result",
      workId: ingested.workId,
      proposalId: prepared.proposal.id,
      proposalHash: prepared.proposal.proposalHash,
      ok: true,
      receiptHash: "a".repeat(64),
      reference: "connector-receipt:sha256:" + "a".repeat(64),
      observedAt: new Date("2026-08-28T14:01:00.000Z").getTime(),
    })).toMatchObject({ status: "recorded", phase: "executed" });
    await expect(restarted.reconcile(ingested.workId)).resolves.toMatchObject({ status: "verified" });
    expect(h.executionCalls).toHaveLength(1);

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("rejects a provider result until the exact action has been durably dispatched", async () => {
    const h = harness({ execution: "handoff" });
    const orchestrator = h.create();
    const ingested = orchestrator.ingest(gmailDraftEvent());
    if (!("workId" in ingested)) throw new Error("expected a work id");
    const prepared = orchestrator.prepare(ingested.workId);
    if (prepared.status !== "prepared") throw new Error("expected a prepared action");

    const restarted = h.create();
    expect(restarted.ingest({
      type: "execution-result",
      workId: ingested.workId,
      proposalId: prepared.proposal.id,
      proposalHash: prepared.proposal.proposalHash,
      ok: true,
      receiptHash: "d".repeat(64),
      reference: `connector-receipt:sha256:${"d".repeat(64)}`,
    })).toMatchObject({ status: "denied", reason: "execution_result_not_dispatched" });
    await expect(orchestrator.reconcile(ingested.workId)).resolves.toMatchObject({
      status: "not_ready",
      reason: "execution_receipt_required",
    });
    expect(h.verificationCalls).toEqual([]);

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("accepts only an exact idempotent replay of the first provider receipt", async () => {
    const h = harness({ execution: "handoff" });
    const orchestrator = h.create();
    const ingested = orchestrator.ingest(gmailDraftEvent());
    if (!("workId" in ingested)) throw new Error("expected a work id");
    const prepared = orchestrator.prepare(ingested.workId);
    if (prepared.status !== "prepared") throw new Error("expected a prepared action");
    const decided = orchestrator.decide({
      workId: ingested.workId,
      approvalId: prepared.approvalId,
      proposalId: prepared.proposal.id,
      proposalHash: prepared.proposal.proposalHash,
      payloadHash: prepared.proposal.payloadHash,
      accountId: prepared.proposal.accountId,
      decision: "approved",
      decidedBy: "Shane",
      evidenceRef: "approval:test:receipt-binding",
    });
    if (decided.status !== "approved") throw new Error("expected approval");
    await expect(orchestrator.execute(ingested.workId)).resolves.toMatchObject({ status: "dispatched" });

    const firstReceipt = {
      type: "execution-result",
      workId: ingested.workId,
      proposalId: prepared.proposal.id,
      proposalHash: prepared.proposal.proposalHash,
      ok: true,
      receiptHash: "e".repeat(64),
      reference: `connector-receipt:sha256:${"e".repeat(64)}`,
    };
    expect(orchestrator.ingest({
      ...firstReceipt,
      reference: `connector-receipt:sha256:${"0".repeat(64)}`,
    })).toMatchObject({ status: "denied", reason: "execution_result_invalid" });
    expect(orchestrator.ingest(firstReceipt)).toMatchObject({ status: "recorded" });
    expect(orchestrator.ingest(firstReceipt)).toMatchObject({ status: "recorded" });
    expect(orchestrator.ingest({
      ...firstReceipt,
      receiptHash: "f".repeat(64),
      reference: `connector-receipt:sha256:${"f".repeat(64)}`,
    })).toMatchObject({ status: "denied", reason: "execution_result_conflict" });

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("fails closed when durable journal bytes cannot be validated after restart", async () => {
    const h = harness();
    const first = h.create();
    const ingested = first.ingest(gmailDraftEvent());
    if (!("workId" in ingested)) throw new Error("expected a work id");
    writeFileSync(h.journalFile, "{not-json", "utf8");

    const restarted = h.create();
    expect(restarted.ingest({ ...gmailDraftEvent(), externalId: "gmail-draft-2" })).toMatchObject({
      status: "denied",
      reason: "journal_unavailable",
    });
    await expect(restarted.execute(ingested.workId)).resolves.toMatchObject({
      status: "not_ready",
      reason: "journal_unavailable",
    });
    expect(h.work.listOpenWork().obligations).toHaveLength(1);
    expect(h.executionCalls).toEqual([]);

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("does not reconstruct and replay existing action work when its journal entry is missing", async () => {
    const h = harness();
    const first = h.create();
    const ingested = first.ingest(gmailDraftEvent());
    if (!("workId" in ingested)) throw new Error("expected a work id");
    rmSync(h.journalFile);

    const restarted = h.create();
    expect(restarted.ingest(gmailDraftEvent())).toMatchObject({
      status: "denied",
      reason: "journal_entry_missing_for_existing_work",
    });
    expect(restarted.prepare(ingested.workId)).toMatchObject({ status: "not_ready" });
    await expect(restarted.execute(ingested.workId)).resolves.toMatchObject({ status: "not_ready" });
    expect(h.executionCalls).toEqual([]);

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("never calls the executor after exact one-time authorization is revoked", async () => {
    const h = harness();
    const orchestrator = h.create();
    const ingested = orchestrator.ingest(gmailDraftEvent());
    if (!("workId" in ingested)) throw new Error("expected a work id");
    const prepared = orchestrator.prepare(ingested.workId);
    if (prepared.status !== "prepared") throw new Error("expected a prepared action");
    const decided = orchestrator.decide({
      workId: ingested.workId,
      approvalId: prepared.approvalId,
      proposalId: prepared.proposal.id,
      proposalHash: prepared.proposal.proposalHash,
      payloadHash: prepared.proposal.payloadHash,
      accountId: prepared.proposal.accountId,
      decision: "approved",
      decidedBy: "Shane",
      evidenceRef: "approval:test:revoked",
    });
    if (decided.status !== "approved") throw new Error("expected approval");
    expect(h.policy.revokeAuthorization(decided.authorizationId)).toBe(true);

    await expect(orchestrator.execute(ingested.workId)).resolves.toMatchObject({ status: "not_ready" });
    expect(h.executionCalls).toEqual([]);

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("blocks an ambiguous mutation boundary across restart without a second executor call", async () => {
    const h = harness({ execution: "throw" });
    const first = h.create();
    const ingested = first.ingest(gmailDraftEvent());
    if (!("workId" in ingested)) throw new Error("expected a work id");
    const prepared = first.prepare(ingested.workId);
    if (prepared.status !== "prepared") throw new Error("expected a prepared action");
    const decided = first.decide({
      workId: ingested.workId,
      approvalId: prepared.approvalId,
      proposalId: prepared.proposal.id,
      proposalHash: prepared.proposal.proposalHash,
      payloadHash: prepared.proposal.payloadHash,
      accountId: prepared.proposal.accountId,
      decision: "approved",
      decidedBy: "Shane",
      evidenceRef: "approval:test:ambiguous",
    });
    if (decided.status !== "approved") throw new Error("expected approval");

    await expect(first.execute(ingested.workId)).resolves.toMatchObject({ status: "ambiguous", phase: "executing" });
    const restarted = h.create();
    await expect(restarted.execute(ingested.workId)).resolves.toMatchObject({ status: "replay_prevented", phase: "executing" });
    await expect(restarted.reconcile(ingested.workId)).resolves.toMatchObject({ status: "replay_prevented", phase: "executing" });
    expect(h.executionCalls).toHaveLength(1);

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("preserves a pending exact approval across restart", async () => {
    const h = harness();
    const first = h.create();
    const ingested = first.ingest(gmailDraftEvent());
    if (!("workId" in ingested)) throw new Error("expected a work id");
    const prepared = first.prepare(ingested.workId);
    if (prepared.status !== "prepared") throw new Error("expected a prepared action");

    const restarted = h.create();
    expect(restarted.prepare(ingested.workId)).toEqual(prepared);
    const decided = restarted.decide({
      workId: ingested.workId,
      approvalId: prepared.approvalId,
      proposalId: prepared.proposal.id,
      proposalHash: prepared.proposal.proposalHash,
      payloadHash: prepared.proposal.payloadHash,
      accountId: prepared.proposal.accountId,
      decision: "approved",
      decidedBy: "Shane",
      evidenceRef: "approval:test:restart",
    });
    expect(decided).toMatchObject({ status: "approved" });
    await expect(restarted.execute(ingested.workId)).resolves.toMatchObject({ status: "executed" });
    expect(h.executionCalls).toHaveLength(1);

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("skips unchanged Capture evidence and wakes exactly once for each changed evidence hash", () => {
    const h = harness();
    const orchestrator = h.create();
    const event = {
      type: "capture",
      source: "gmail",
      sourceId: "message-42",
      evidenceHash: "b".repeat(64),
      title: "Customer reply needs judgment",
      summary: "The customer replied with a new scheduling constraint.",
      ownerId: "owner-1",
      evidenceRef: "capture:gmail:message-42",
    };
    expect(orchestrator.ingest(event)).toMatchObject({ status: "created", changed: true });
    expect(orchestrator.ingest(event)).toMatchObject({ status: "unchanged", changed: false });
    expect(orchestrator.ingest({ ...event, evidenceHash: "c".repeat(64) })).toMatchObject({ status: "created", changed: true });
    expect(h.work.listOpenWork().obligations).toHaveLength(2);

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("turns an authoritative Capture receipt into fresh canonical work and dedupes it across runs", () => {
    const h = harness();
    const orchestrator = h.create();
    const observedAt = new Date("2026-08-28T16:30:00.000Z").getTime();
    const action = {
      class: "Calendar/RSVP",
      source: "gmail",
      summary: "Customer requested a different meeting time.",
      ask: "Choose a new time before replying.",
      proposedMove: "Review the calendar and prepare a response.",
      evidenceRef: "gmail:thread:customer-42",
    };
    const receipt = {
      report: {
        runId: "capture-run-1",
        kind: "fast",
        scheduledFor: observedAt,
        status: "completed",
        sourceHealth: [{ sourceId: "gmail", required: true, status: "ok", itemCount: 1 }],
        actionItems: [action],
      },
      outbox: null,
    };

    expect(orchestrator.ingest({ type: "capture-receipt", ownerId: "owner-1", receipt })).toMatchObject({
      status: "created",
      changed: true,
      createdCount: 1,
      unchangedCount: 0,
    });
    const restarted = h.create();
    expect(restarted.ingest({
      type: "capture-receipt",
      ownerId: "owner-1",
      receipt: {
        ...receipt,
        report: { ...receipt.report, runId: "capture-run-2", scheduledFor: observedAt + 60_000 },
      },
    })).toMatchObject({
      status: "unchanged",
      changed: false,
      createdCount: 0,
      unchangedCount: 1,
    });

    const projection = h.work.listOpenWork();
    expect(projection.obligations).toHaveLength(1);
    expect(projection.obligations[0]).toMatchObject({
      title: action.summary,
      owner: { id: "owner-1" },
      metadata: {
        kind: "capture",
        source: "gmail",
        sourceId: action.evidenceRef,
        evidenceRef: action.evidenceRef,
        captureRunId: "capture-run-1",
        actionClass: action.class,
        observedAt,
      },
      evidence: [{
        kind: "capture",
        reference: action.evidenceRef,
        recordedAt: observedAt,
        metadata: {
          source: "gmail",
          sourceId: action.evidenceRef,
          captureRunId: "capture-run-1",
          actionClass: action.class,
          observedAt,
        },
      }],
    });
    expect(projection.obligations[0]?.metadata).toMatchObject({
      evidenceHash: "3600a0abf99ceb6513b51db2eada819c598d082a457048ed7cd10729e5671e39",
    });

    h.work.close();
    h.policy.close();
    h.telemetry.close();
  });

  it("does not reconstruct Capture work when its orchestrator journal entry is missing", () => {
    const h = harness();
    const observedAt = new Date("2026-08-28T16:45:00.000Z").getTime();
    const evidenceHash = "6dfa940899bde729ae25f7dfd864c5474177108be663dad4a12359d9e45caf11";
    h.work.createObligation({
      title: "Existing Capture work",
      externalIdentity: {
        source: "capture:gmail",
        id: `918df4b67939e4603605886153ab5e936ea4945b7db6a85d98f990fe4c56e716:${evidenceHash}`,
      },
      ownerId: "owner-1",
    });
    const orchestrator = h.create();

    try {
      expect(orchestrator.ingest({
        type: "capture-receipt",
        ownerId: "owner-1",
        receipt: {
          report: {
            runId: "capture-run-orphan",
            kind: "fast",
            scheduledFor: observedAt,
            status: "completed",
            sourceHealth: [{ sourceId: "gmail", required: true, status: "ok", itemCount: 1 }],
            actionItems: [{
              class: "Build",
              source: "gmail",
              summary: "Ship fix.",
              evidenceRef: "gmail:item:1",
            }],
          },
          outbox: null,
        },
      })).toEqual({ status: "denied", reason: "journal_entry_missing_for_existing_work" });
      expect(h.work.listOpenWork().obligations[0]?.evidence).toEqual([]);
    } finally {
      h.work.close();
      h.policy.close();
      h.telemetry.close();
    }
  });
});
