/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof,
 * anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion
 * -- provider events and journal bytes are untrusted JSON and are narrowed at
 * this orchestration boundary. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { AccountDirectory } from "./account-directory.ts";
import { canonicalizeActionPayload, type ActionPolicy, type ActionProposal } from "./action-policy.ts";
import { createProviderActionAdapter } from "./provider-action-adapter.ts";
import type { JsonObject, JsonValue } from "./schema.ts";
import type { AutonomyTelemetryInterface } from "./autonomy-telemetry.ts";
import type { WorkEvidence, WorkLockStoreInterface } from "./work-lock-store.ts";

export interface WorkActionReceipt {
  readonly ok: boolean;
  readonly reference: string;
  readonly observedAt?: number | string;
  readonly [key: string]: JsonValue | undefined;
}

export type WorkActionExecutionResult =
  | { readonly kind: "final"; readonly receipt: WorkActionReceipt }
  | { readonly kind: "handoff"; readonly reference: string };

export interface WorkActionExecutor {
  execute(proposal: ActionProposal): Promise<WorkActionExecutionResult>;
}

export type WorkVerificationResult =
  | { readonly status: "verified"; readonly evidence: Pick<WorkEvidence, "kind" | "reference" | "summary" | "recordedAt"> & { readonly metadata?: JsonValue | null } }
  | { readonly status: "not_verified"; readonly reason: string };

export interface WorkActionVerifier {
  verify(proposal: ActionProposal, receipt: WorkActionReceipt): Promise<WorkVerificationResult>;
}

export interface WorkActionEvent {
  readonly type: "action";
  readonly source: string;
  readonly externalId: string;
  readonly title: string;
  readonly description?: string;
  readonly ownerId: string;
  readonly ownerLabel?: string;
  readonly identity: string;
  readonly provider: string;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly requestedBy?: string;
  readonly workScope?: "aws" | "other";
}

export interface CaptureWorkEvent {
  readonly type: "capture";
  readonly source: string;
  readonly sourceId: string;
  readonly evidenceHash: string;
  readonly title: string;
  readonly summary?: string;
  readonly ownerId: string;
  readonly evidenceRef: string;
  readonly captureRunId?: string;
  readonly actionClass?: string;
  readonly observedAt?: number;
}

/** A one-way legacy-profile record. It can create pending work metadata, but
 * carries no provider operation, payload, authorization, or execution grant. */
export interface ProfileWorkEvent {
  readonly type: "profile-import";
  readonly source: string;
  readonly profileId: string;
  readonly externalId: string;
  readonly contentHash: string;
  readonly title: string;
  readonly description?: string;
  readonly ownerId: string;
  readonly ownerLabel?: string;
  readonly evidence: {
    readonly reference: string;
    readonly summary: string;
    readonly observedAt: number;
  };
  readonly deadline?: {
    readonly key: string;
    readonly label: string;
    readonly dueAt: number;
  };
  readonly approval?: {
    readonly key: string;
    readonly prompt: string;
    readonly requestedBy?: string;
  };
  readonly guards: readonly string[];
}

export interface ExecutionResultEvent {
  readonly type: "execution-result";
  readonly workId: string;
  readonly proposalId: string;
  readonly proposalHash: string;
  readonly ok: boolean;
  readonly receiptHash: string;
  readonly reference: string;
  readonly observedAt?: number;
}

export interface WorkWorkerTask {
  readonly key?: string;
  readonly label: string;
  readonly prompt: string;
  readonly resumePolicy: "safe" | "never";
  readonly dependsOn?: readonly string[];
  readonly resourceLocks?: readonly string[];
  readonly approvalGate?: string;
  readonly metadata?: JsonObject;
}

export interface WorkWorkerEvent {
  readonly type: "worker-batch";
  readonly source: string;
  readonly externalId: string;
  readonly title: string;
  readonly ownerId: string;
  readonly taskId: string;
  readonly tasks: readonly WorkWorkerTask[];
  readonly metadata?: JsonObject;
}

export type WorkWorkerStatus =
  | { readonly status: "queued" }
  | { readonly status: "running" }
  | { readonly status: "completed"; readonly reference: string; readonly summary: string; readonly recordedAt: number }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "canceled"; readonly reason: string }
  | { readonly status: "missing" };

export interface WorkWorkerExecutor {
  dispatch(event: WorkWorkerEvent, batchId: string): Promise<{ readonly batchId: string; readonly settled: Promise<void> }>;
  inspect(batchId: string, expectedTaskCount: number): WorkWorkerStatus | Promise<WorkWorkerStatus>;
}

export type WorkEvent = WorkActionEvent | CaptureWorkEvent | ProfileWorkEvent | WorkWorkerEvent | ExecutionResultEvent;

type JournalPhase = "ingested" | "prepared" | "approved" | "executing" | "dispatched" | "executed" | "verified" | "rejected";
interface JournalEntry {
  readonly workId: string;
  readonly kind: "action" | "capture" | "profile" | "worker";
  readonly phase: JournalPhase;
  readonly event: WorkEvent;
  readonly proposalId?: string;
  readonly proposal?: ActionProposal;
  readonly approvalId?: string;
  readonly authorizationId?: string;
  readonly receipt?: WorkActionReceipt;
  readonly receiptHash?: string;
  readonly captureEvidenceHash?: string;
  readonly workerBatchId?: string;
  readonly updatedAt: number;
}

type JournalLoadResult =
  | { readonly status: "ready"; readonly entries: readonly JournalEntry[] }
  | { readonly status: "unavailable" };

const receiptSchema = z.object({
  ok: z.boolean(),
  reference: z.string().min(1).max(2_000),
  observedAt: z.union([z.number().finite(), z.string()]).optional(),
}).passthrough();
const proposalSchema = z.object({
  id: z.string(), operation: z.string(), accountId: z.string(), accountHash: z.string(), payload: z.json(),
  payloadHash: z.string(), proposalHash: z.string(), ownerId: z.string(), evidence: z.array(z.string()), createdAt: z.number(),
});
const journalEntrySchema = z.object({
  workId: z.string(), kind: z.enum(["action", "capture", "profile", "worker"]), phase: z.enum(["ingested", "prepared", "approved", "executing", "dispatched", "executed", "verified", "rejected"]),
  event: z.unknown(), proposalId: z.string().optional(), proposal: proposalSchema.optional(), approvalId: z.string().optional(), authorizationId: z.string().optional(),
  receipt: receiptSchema.optional(), receiptHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(), captureEvidenceHash: z.string().optional(), workerBatchId: z.string().optional(), updatedAt: z.number(),
});
const journalSchema = z.object({ version: z.literal(1), entries: z.array(journalEntrySchema) });
const captureReceiptEventSchema = z.object({
  type: z.literal("capture-receipt"),
  ownerId: z.string().trim().min(1).max(300),
  receipt: z.object({
    report: z.object({
      runId: z.string().trim().min(1).max(300),
      kind: z.enum(["fast", "hourly", "manual"]),
      scheduledFor: z.number().finite().nonnegative(),
      status: z.enum(["completed", "degraded"]),
      sourceHealth: z.array(z.object({
        sourceId: z.string().trim().min(1).max(120),
        required: z.boolean(),
        status: z.enum(["ok", "empty", "failed", "needs-auth"]),
        itemCount: z.number().finite().nonnegative(),
        error: z.string().optional(),
      })).max(100),
      actionItems: z.array(z.object({
        class: z.enum(["Build", "Money chase", "Collect then deliver", "Outbound follow-up", "Redline/legal", "Calendar/RSVP", "File a loop"]),
        source: z.string().trim().min(1).max(120),
        summary: z.string().trim().min(1).max(2_000),
        ask: z.string().trim().min(1).max(1_000).optional(),
        proposedMove: z.string().trim().min(1).max(1_000).optional(),
        evidenceRef: z.string().trim().min(1).max(500).optional(),
      }).strict()).max(100),
    }).strict(),
  }).passthrough(),
}).strict();
const workerEventSchema = z.object({
  type: z.literal("worker-batch"),
  source: z.string().trim().min(1).max(120),
  externalId: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  ownerId: z.string().trim().min(1).max(300),
  taskId: z.string().trim().min(1).max(300),
  tasks: z.array(z.object({
    key: z.string().trim().min(1).max(120).optional(),
    label: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(25_000),
    resumePolicy: z.enum(["safe", "never"]),
    dependsOn: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
    resourceLocks: z.array(z.string().trim().min(1).max(300)).max(8).optional(),
    approvalGate: z.string().trim().min(1).max(300).optional(),
    metadata: z.record(z.string(), z.json()).optional(),
  }).strict()).min(1).max(8),
  metadata: z.record(z.string(), z.json()).optional(),
}).strict();
const profileWorkEventSchema = z.object({
  type: z.literal("profile-import"),
  source: z.string().trim().min(1).max(80),
  profileId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  externalId: z.string().trim().min(1).max(500),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().trim().min(1).max(1_000),
  description: z.string().max(20_000).optional(),
  ownerId: z.string().trim().min(1).max(300),
  ownerLabel: z.string().trim().min(1).max(500).optional(),
  evidence: z.object({
    reference: z.string().trim().min(1).max(2_000),
    summary: z.string().trim().min(1).max(4_000),
    observedAt: z.number().finite(),
  }).strict(),
  deadline: z.object({
    key: z.string().trim().min(1).max(300),
    label: z.string().trim().min(1).max(500),
    dueAt: z.number().finite(),
  }).strict().optional(),
  approval: z.object({
    key: z.string().trim().min(1).max(300),
    prompt: z.string().trim().min(1).max(4_000),
    requestedBy: z.string().trim().min(1).max(300).optional(),
  }).strict().optional(),
  guards: z.array(z.string().trim().min(1).max(120)).max(30),
}).strict();

export interface WorkOrchestratorOptions {
  readonly work: WorkLockStoreInterface;
  readonly accounts: AccountDirectory;
  readonly policy: ActionPolicy;
  readonly telemetry: AutonomyTelemetryInterface;
  readonly executor: WorkActionExecutor;
  readonly verifier: WorkActionVerifier;
  readonly worker?: WorkWorkerExecutor;
  readonly journalFile: string;
  /** AccountDirectory is installation-scoped while work owners are bot-scoped. */
  readonly accountOwnerId?: string;
  readonly now?: () => number;
}

export interface WorkOrchestrator {
  ingest(event: unknown):
    | { readonly status: "created"; readonly phase: "ingested"; readonly workId: string; readonly changed?: boolean }
    | { readonly status: "unchanged"; readonly phase: "ingested"; readonly changed: false; readonly workId: string }
    | { readonly status: "created"; readonly phase: "ingested"; readonly changed: true; readonly createdCount: number; readonly unchangedCount: number; readonly workIds: readonly string[] }
    | { readonly status: "unchanged"; readonly phase: "ingested"; readonly changed: false; readonly createdCount: 0; readonly unchangedCount: number; readonly workIds: readonly string[] }
    | { readonly status: "recorded"; readonly phase: "executed"; readonly workId: string }
    | { readonly status: "denied"; readonly reason: string };
  prepare(workId: string):
    | { readonly status: "prepared"; readonly phase: "prepared"; readonly workId: string; readonly proposal: ActionProposal; readonly approvalId: string; readonly authorizationId?: string }
    | { readonly status: "blocked"; readonly reason: string; readonly workId: string }
    | { readonly status: "not_ready"; readonly reason: string; readonly workId: string };
  decide(input: WorkApprovalDecisionInput):
    | { readonly status: "approved"; readonly phase: "approved"; readonly workId: string; readonly authorizationId: string }
    | { readonly status: "rejected"; readonly phase: "rejected"; readonly workId: string }
    | { readonly status: "denied"; readonly reason: "decision_mismatch" | "not_ready"; readonly workId: string };
  execute(workId: string): Promise<
    | { readonly status: "executed"; readonly phase: "executed"; readonly workId: string }
    | { readonly status: "dispatched"; readonly phase: "dispatched"; readonly workId: string }
    | { readonly status: "replay_prevented"; readonly phase: JournalPhase; readonly workId: string }
    | { readonly status: "not_ready"; readonly reason: string; readonly workId: string }
    | { readonly status: "ambiguous"; readonly phase: "executing"; readonly workId: string }
  >;
  reconcile(workId: string): Promise<
    | { readonly status: "verified"; readonly phase: "verified"; readonly workId: string }
    | { readonly status: "not_verified"; readonly reason: string; readonly workId: string }
    | { readonly status: "awaiting_receipt"; readonly phase: "dispatched"; readonly workId: string }
    | { readonly status: "awaiting_worker"; readonly phase: "dispatched"; readonly workId: string }
    | { readonly status: "replay_prevented"; readonly phase: "executing"; readonly workId: string }
    | { readonly status: "not_ready"; readonly reason: string; readonly workId: string }
  >;
}

export interface WorkApprovalDecisionInput {
  readonly workId: string;
  readonly approvalId: string;
  readonly proposalId: string;
  readonly proposalHash: string;
  readonly payloadHash: string;
  readonly accountId: string;
  readonly decision: "approved" | "rejected";
  readonly decidedBy: string;
  readonly evidenceRef: string;
}

export function createWorkOrchestrator(options: WorkOrchestratorOptions): WorkOrchestrator {
  const now = options.now ?? Date.now;
  const entries = new Map<string, JournalEntry>();
  const adapter = createProviderActionAdapter({ policy: options.policy, accounts: options.accounts });
  const loadedJournal = loadJournal(options.journalFile);

  if (loadedJournal.status === "ready") {
    loadedJournal.entries.forEach((entry) => entries.set(entry.workId, entry));
  }

  function save(entry: JournalEntry): void {
    entries.set(entry.workId, entry);
    const payload = JSON.stringify({ version: 1, entries: [...entries.values()] });
    mkdirSync(dirname(options.journalFile), { recursive: true });
    writeFileAtomic(options.journalFile, payload, { mode: 0o600 });
  }

  function update(entry: JournalEntry, patch: Partial<JournalEntry>): JournalEntry {
    const next = { ...entry, ...patch, updatedAt: now() };
    save(next);
    return next;
  }

  function actionEntry(workId: string): JournalEntry | null {
    const entry = entries.get(workId);
    return entry ?? null;
  }

  function ingest(rawEvent: unknown) {
    if (loadedJournal.status === "unavailable") return { status: "denied" as const, reason: "journal_unavailable" };
    const receiptEvent = captureReceiptEventSchema.safeParse(rawEvent);
    if (receiptEvent.success) return ingestCaptureReceipt(receiptEvent.data);
    const event = parseWorkEvent(rawEvent);
    if (!event) return { status: "denied" as const, reason: "invalid_work_event" };
    if (event.type === "execution-result") return recordExecutionResult(event);
    if (event.type === "action") return ingestAction(event);
    if (event.type === "worker-batch") return ingestWorker(event);
    if (event.type === "profile-import") return ingestProfile(event);
    return ingestCapture(event);
  }

  function ingestCaptureReceipt(event: z.infer<typeof captureReceiptEventSchema>) {
    const healthySources = new Set(event.receipt.report.sourceHealth
      .filter((source) => source.status === "ok" || source.status === "empty")
      .map((source) => source.sourceId));
    if (event.receipt.report.actionItems.some((action) => !healthySources.has(action.source))) {
      return { status: "denied" as const, reason: "capture_action_source_not_healthy" };
    }
    const events = event.receipt.report.actionItems.map((action): CaptureWorkEvent => {
      const identityMaterial = JSON.stringify([
        action.class,
        action.source,
        action.summary,
        action.ask ?? null,
        action.proposedMove ?? null,
        action.evidenceRef ?? null,
      ]);
      const evidenceHash = createHash("sha256").update(identityMaterial, "utf8").digest("hex");
      const evidenceRef = action.evidenceRef ?? `capture:${action.source}:sha256:${evidenceHash}`;
      const details = [
        action.ask ? `Ask: ${action.ask}` : null,
        action.proposedMove ? `Proposed move: ${action.proposedMove}` : null,
      ].filter((detail): detail is string => detail !== null);
      return {
        type: "capture",
        source: action.source,
        sourceId: action.evidenceRef ?? `content:sha256:${evidenceHash}`,
        evidenceHash,
        title: action.summary,
        summary: details.length > 0 ? details.join("\n") : undefined,
        ownerId: event.ownerId,
        evidenceRef,
        captureRunId: event.receipt.report.runId,
        actionClass: action.class,
        observedAt: event.receipt.report.scheduledFor,
      };
    });
    let createdCount = 0;
    let unchangedCount = 0;
    const workIds: string[] = [];
    for (const captureEvent of events) {
      const result = ingestCapture(captureEvent);
      if (result.status === "denied") return result;
      workIds.push(result.workId);
      if (result.status === "created") createdCount += 1;
      else unchangedCount += 1;
    }
    if (createdCount > 0) {
      return { status: "created" as const, phase: "ingested" as const, changed: true as const, createdCount, unchangedCount, workIds };
    }
    return { status: "unchanged" as const, phase: "ingested" as const, changed: false as const, createdCount: 0 as const, unchangedCount, workIds };
  }

  function ingestAction(event: WorkActionEvent) {
    const identity = { source: `action:${event.source}`, id: event.externalId };
    const created = options.work.createObligation({
      title: event.title,
      description: event.description,
      externalIdentity: identity,
      ownerId: event.ownerId,
      ownerLabel: event.ownerLabel,
      metadata: { kind: "action", identity: event.identity, provider: event.provider, toolName: event.toolName },
    });
    const existing = entries.get(created.obligation.id);
    if (existing) return { status: "unchanged" as const, phase: "ingested" as const, changed: false as const, workId: created.obligation.id };
    if (created.status === "deduplicated") return { status: "denied" as const, reason: "journal_entry_missing_for_existing_work" };
    const entry: JournalEntry = { workId: created.obligation.id, kind: "action", phase: "ingested", event, updatedAt: now() };
    save(entry);
    recordStarted(created.obligation.id, event.workScope ?? "other");
    return { status: "created" as const, phase: "ingested" as const, workId: created.obligation.id };
  }

  function ingestCapture(event: CaptureWorkEvent) {
    const source = `capture:${event.source}`;
    const evidenceHash = event.evidenceHash.toLowerCase();
    const sourceIdentityHash = createHash("sha256").update(event.sourceId, "utf8").digest("hex");
    const id = `${sourceIdentityHash}:${evidenceHash}`;
    const metadata = {
      kind: "capture",
      source: event.source,
      sourceId: event.sourceId,
      evidenceHash,
      evidenceRef: event.evidenceRef,
      captureRunId: event.captureRunId ?? null,
      actionClass: event.actionClass ?? null,
      observedAt: event.observedAt ?? null,
    };
    const created = options.work.createObligation({
      title: event.title,
      description: event.summary,
      externalIdentity: { source, id },
      ownerId: event.ownerId,
      metadata,
    });
    const existing = entries.get(created.obligation.id);
    if (existing) return { status: "unchanged" as const, phase: "ingested" as const, changed: false as const, workId: created.obligation.id };
    if (created.status === "deduplicated") return { status: "denied" as const, reason: "journal_entry_missing_for_existing_work" };
    const entry: JournalEntry = { workId: created.obligation.id, kind: "capture", phase: "ingested", event, captureEvidenceHash: evidenceHash, updatedAt: now() };
    save(entry);
    options.work.recordEvidence(created.obligation.id, {
      kind: "capture",
      reference: event.evidenceRef,
      summary: event.summary ?? event.title,
      recordedAt: event.observedAt ?? now(),
      metadata: {
        source: event.source,
        sourceId: event.sourceId,
        evidenceHash,
        captureRunId: event.captureRunId ?? null,
        actionClass: event.actionClass ?? null,
        observedAt: event.observedAt ?? null,
      },
    });
    recordStarted(created.obligation.id, "aws");
    return { status: "created" as const, phase: "ingested" as const, changed: true as const, workId: created.obligation.id };
  }

  function ingestProfile(event: ProfileWorkEvent) {
    if (profileEventHash(event) !== event.contentHash) {
      return { status: "denied" as const, reason: "profile_event_hash_mismatch" };
    }
    const created = options.work.createObligation({
      title: event.title,
      description: event.description,
      externalIdentity: { source: `profile:${event.profileId}:${event.source}`, id: event.externalId },
      ownerId: event.ownerId,
      ownerLabel: event.ownerLabel,
      metadata: {
        kind: "profile-import",
        source: event.source,
        profileId: event.profileId,
        externalId: event.externalId,
        contentHash: event.contentHash,
        guards: [...event.guards],
      },
      deadline: event.deadline,
      approval: event.approval,
      evidence: {
        kind: "legacy-profile",
        reference: event.evidence.reference,
        summary: event.evidence.summary,
        recordedAt: event.evidence.observedAt,
        metadata: {
          source: event.source,
          profileId: event.profileId,
          externalId: event.externalId,
          contentHash: event.contentHash,
        },
      },
    });
    const existing = entries.get(created.obligation.id);
    if (existing) {
      if (existing.kind !== "profile" || existing.event.type !== "profile-import" || profileEventHash(existing.event) !== event.contentHash) {
        return { status: "denied" as const, reason: "profile_event_conflict" };
      }
      return { status: "unchanged" as const, phase: "ingested" as const, changed: false as const, workId: created.obligation.id };
    }
    if (created.status === "deduplicated") return { status: "denied" as const, reason: "journal_entry_missing_for_existing_work" };
    const entry: JournalEntry = { workId: created.obligation.id, kind: "profile", phase: "ingested", event, updatedAt: now() };
    save(entry);
    recordStarted(created.obligation.id, "other");
    return { status: "created" as const, phase: "ingested" as const, changed: true as const, workId: created.obligation.id };
  }

  function ingestWorker(event: WorkWorkerEvent) {
    const created = options.work.createObligation({
      title: event.title,
      externalIdentity: { source: `worker:${event.source}`, id: event.externalId },
      ownerId: event.ownerId,
      metadata: { kind: "worker-batch", taskId: event.taskId, taskCount: event.tasks.length, ...event.metadata },
    });
    const existing = entries.get(created.obligation.id);
    if (existing) {
      if (existing.kind !== "worker" || existing.event.type !== "worker-batch" || workerEventHash(existing.event) !== workerEventHash(event)) {
        return { status: "denied" as const, reason: "worker_event_conflict" };
      }
      return { status: "unchanged" as const, phase: "ingested" as const, changed: false as const, workId: created.obligation.id };
    }
    if (created.status === "deduplicated") return { status: "denied" as const, reason: "journal_entry_missing_for_existing_work" };
    const entry: JournalEntry = { workId: created.obligation.id, kind: "worker", phase: "ingested", event, updatedAt: now() };
    save(entry);
    recordStarted(created.obligation.id, "other");
    return { status: "created" as const, phase: "ingested" as const, workId: created.obligation.id };
  }

  function recordExecutionResult(event: ExecutionResultEvent) {
    const entry = entries.get(event.workId);
    if (!entry || entry.kind !== "action" || !entry.proposal || entry.proposal.id !== event.proposalId || entry.proposal.proposalHash !== event.proposalHash) {
      return { status: "denied" as const, reason: "execution_result_mismatch" };
    }
    if (!/^[a-f0-9]{64}$/i.test(event.receiptHash) || event.reference !== `connector-receipt:sha256:${event.receiptHash.toLowerCase()}`) {
      return { status: "denied" as const, reason: "execution_result_invalid" };
    }
    if (entry.phase === "verified" || entry.phase === "executed") {
      const exactReplay = entry.receiptHash?.toLowerCase() === event.receiptHash.toLowerCase()
        && entry.receipt?.ok === event.ok
        && entry.receipt.reference === event.reference;
      return exactReplay
        ? { status: "recorded" as const, phase: "executed" as const, workId: event.workId }
        : { status: "denied" as const, reason: "execution_result_conflict" };
    }
    if (entry.phase !== "dispatched") return { status: "denied" as const, reason: "execution_result_not_dispatched" };
    const receipt: WorkActionReceipt = { ok: event.ok, reference: event.reference, observedAt: event.observedAt };
    update(entry, { phase: "executed", receipt, receiptHash: event.receiptHash.toLowerCase() });
    return { status: "recorded" as const, phase: "executed" as const, workId: event.workId };
  }

  function prepare(workId: string) {
    if (loadedJournal.status === "unavailable") return { status: "not_ready" as const, reason: "journal_unavailable", workId };
    const entry = actionEntry(workId);
    if (entry?.kind === "worker") return { status: "not_ready" as const, reason: "worker_work_does_not_require_preparation", workId };
    if (!entry || entry.kind !== "action" || entry.event.type !== "action") return { status: "not_ready" as const, reason: "work_not_found_or_not_action", workId };
    if (entry.proposal && entry.phase === "approved" && entry.authorizationId) return { status: "prepared" as const, phase: "prepared" as const, workId, proposal: entry.proposal, approvalId: entry.approvalId ?? "policy-auto", authorizationId: entry.authorizationId };
    if (entry.proposal && entry.approvalId && entry.phase === "prepared") return { status: "prepared" as const, phase: "prepared" as const, workId, proposal: entry.proposal, approvalId: entry.approvalId };
    if (entry.proposal && ["executing", "dispatched", "executed", "verified"].includes(entry.phase)) return { status: "not_ready" as const, reason: "action_already_dispatched", workId };
    const event = entry.event;
    const prepared = adapter.prepare({ toolName: event.toolName, arguments: event.arguments, identity: event.identity, provider: event.provider, ownerId: event.ownerId, accountOwnerId: options.accountOwnerId ?? event.ownerId });
    if ("status" in prepared) return { status: "blocked" as const, reason: prepared.reason.includes("account") ? "account_not_resolved" : prepared.reason, workId };
    const proposal = prepared.proposal;
    const updated = update(entry, { phase: "prepared", proposal, proposalId: proposal.id });
    options.work.transitionObligation(workId, "in_progress");
    const policyDecision = options.policy.evaluate(proposal);
    if (policyDecision.effect === "allow" || (policyDecision.effect === "draft-only" && proposal.operation === "gmail.drafts.create")) {
      const authorization = options.policy.authorizeOnce(proposal, {
        approvedBy: "ActionPolicy",
        approvalEvidence: `action-policy:${policyDecision.ruleId ?? "allow"}`,
        approvedAt: now(),
      });
      update(entries.get(workId) ?? updated, { phase: "approved", authorizationId: authorization.id });
      return { status: "prepared" as const, phase: "prepared" as const, workId, proposal, approvalId: "policy-auto", authorizationId: authorization.id };
    }
    const approval = options.work.addApproval(workId, {
      key: proposal.proposalHash,
      prompt: `Approve ${proposal.operation} for account ${proposal.accountId}`,
      requestedBy: event.requestedBy ?? event.ownerLabel ?? event.ownerId,
      payload: { operation: proposal.operation, accountId: proposal.accountId, payloadHash: proposal.payloadHash, proposalHash: proposal.proposalHash },
    });
    const approvalId = approval.approval.id;
    update(updated, { approvalId });
    recordApprovalRequested(workId, proposal.proposalHash);
    return { status: "prepared" as const, phase: "prepared" as const, workId, proposal, approvalId };
  }

  function decide(input: WorkApprovalDecisionInput) {
    if (loadedJournal.status === "unavailable") return { status: "denied" as const, reason: "not_ready" as const, workId: input.workId };
    const entry = entries.get(input.workId);
    const proposal = entry?.proposal;
    if (!entry || !proposal || entry.approvalId !== input.approvalId || proposal.id !== input.proposalId || proposal.proposalHash !== input.proposalHash || proposal.payloadHash !== input.payloadHash || proposal.accountId !== input.accountId) {
      return { status: "denied" as const, reason: "decision_mismatch" as const, workId: input.workId };
    }
    if (entry.phase !== "prepared") return { status: "denied" as const, reason: "not_ready" as const, workId: input.workId };
    const current = options.work.getObligation(input.workId);
    if (!current) return { status: "denied" as const, reason: "not_ready" as const, workId: input.workId };
    const approval = current.approvals.find((candidate) => candidate.id === input.approvalId);
    if (!approval || approval.status !== "pending") return { status: "denied" as const, reason: "not_ready" as const, workId: input.workId };
    const decided = options.work.decideApproval(input.workId, input.approvalId, input.decision, input.decidedBy);
    if (input.decision === "rejected") {
      options.work.transitionObligation(input.workId, "blocked", decided.obligation.version);
      update(entry, { phase: "rejected" });
      recordApprovalDecision(input.workId, input.approvalId, "rejected");
      return { status: "rejected" as const, phase: "rejected" as const, workId: input.workId };
    }
    const authorization = options.policy.authorizeOnce(proposal, { approvedBy: input.decidedBy, approvalEvidence: input.evidenceRef, approvedAt: now() });
    update(entry, { phase: "approved", authorizationId: authorization.id });
    recordApprovalDecision(input.workId, input.approvalId, "approved");
    void decided;
    return { status: "approved" as const, phase: "approved" as const, workId: input.workId, authorizationId: authorization.id };
  }

  async function execute(workId: string) {
    if (loadedJournal.status === "unavailable") return { status: "not_ready" as const, reason: "journal_unavailable", workId };
    const entry = entries.get(workId);
    if (entry?.kind === "worker" && entry.event.type === "worker-batch") {
      if (["executing", "dispatched", "verified", "rejected"].includes(entry.phase)) {
        return { status: "replay_prevented" as const, phase: entry.phase, workId };
      }
      if (entry.phase !== "ingested") return { status: "not_ready" as const, reason: "worker_work_not_ready", workId };
      if (!options.worker) return { status: "not_ready" as const, reason: "worker_executor_unavailable", workId };
      options.work.transitionObligation(workId, "in_progress");
      const executing = update(entry, { phase: "executing", workerBatchId: workId });
      let dispatched: Awaited<ReturnType<WorkWorkerExecutor["dispatch"]>>;
      try { dispatched = await options.worker.dispatch(entry.event, workId); }
      catch { return { status: "ambiguous" as const, phase: "executing" as const, workId }; }
      if (dispatched.batchId !== workId) return { status: "ambiguous" as const, phase: "executing" as const, workId };
      update(executing, { phase: "dispatched" });
      void dispatched.settled.then(() => reconcile(workId)).catch(() => undefined);
      return { status: "dispatched" as const, phase: "dispatched" as const, workId };
    }
    if (!entry || entry.kind !== "action" || !entry.proposal) return { status: "not_ready" as const, reason: "work_not_found_or_not_prepared", workId };
    if (["executing", "dispatched", "executed", "verified", "rejected"].includes(entry.phase)) return { status: "replay_prevented" as const, phase: entry.phase, workId };
    if (entry.phase !== "approved" || !entry.authorizationId) return { status: "not_ready" as const, reason: "approval_required", workId };
    const executing = update(entry, { phase: "executing" });
    const decision = options.policy.consumeAuthorization(entry.authorizationId, entry.proposal);
    if (!decision.allowed) {
      update(executing, { phase: "rejected" });
      return { status: "not_ready" as const, reason: decision.reason, workId };
    }
    let result: WorkActionExecutionResult;
    try { result = await options.executor.execute(entry.proposal); }
    catch { return { status: "ambiguous" as const, phase: "executing" as const, workId }; }
    if (result.kind === "handoff") {
      update(executing, { phase: "dispatched" });
      return { status: "dispatched" as const, phase: "dispatched" as const, workId };
    }
    update(executing, { phase: "executed", receipt: result.receipt });
    return { status: "executed" as const, phase: "executed" as const, workId };
  }

  async function reconcile(workId: string) {
    if (loadedJournal.status === "unavailable") return { status: "not_ready" as const, reason: "journal_unavailable", workId };
    const entry = entries.get(workId);
    if (entry?.kind === "worker" && entry.event.type === "worker-batch") {
      if (entry.phase === "verified") return { status: "verified" as const, phase: "verified" as const, workId };
      if (!entry.workerBatchId || entry.phase === "ingested") return { status: "not_ready" as const, reason: "worker_dispatch_required", workId };
      if (!options.worker) return { status: "not_ready" as const, reason: "worker_executor_unavailable", workId };
      let status: WorkWorkerStatus;
      try { status = await options.worker.inspect(entry.workerBatchId, entry.event.tasks.length); }
      catch { return { status: "not_ready" as const, reason: "worker_status_unavailable", workId }; }
      if (status.status === "missing") {
        return entry.phase === "executing"
          ? { status: "replay_prevented" as const, phase: "executing" as const, workId }
          : { status: "not_ready" as const, reason: "worker_batch_unavailable", workId };
      }
      if (status.status === "queued" || status.status === "running") {
        if (entry.phase === "executing") update(entry, { phase: "dispatched" });
        return { status: "awaiting_worker" as const, phase: "dispatched" as const, workId };
      }
      if (status.status === "failed" || status.status === "canceled") {
        return { status: "not_verified" as const, reason: status.reason, workId };
      }
      const evidence = options.work.recordEvidence(workId, {
        kind: "worker-batch",
        reference: status.reference,
        summary: status.summary,
        recordedAt: status.recordedAt,
        metadata: { batchId: entry.workerBatchId, taskId: entry.event.taskId, taskCount: entry.event.tasks.length },
      });
      options.work.completeObligation(workId);
      update(entry, { phase: "verified" });
      options.telemetry.record({ type: "outcome.verified", workId, idempotencyKey: `outcome.verified:${workId}:${evidence.evidence.id}`, evidenceRef: evidence.evidence.reference, observedAt: evidence.evidence.recordedAt });
      options.telemetry.record({ type: "work.closed", workId, idempotencyKey: `work.closed:${workId}`, observedAt: now(), closureKind: "success" });
      return { status: "verified" as const, phase: "verified" as const, workId };
    }
    if (!entry || entry.kind !== "action" || !entry.proposal) return { status: "not_ready" as const, reason: "work_not_found_or_not_action", workId };
    if (entry.phase === "dispatched") return { status: "awaiting_receipt" as const, phase: "dispatched" as const, workId };
    if (entry.phase === "executing") return { status: "replay_prevented" as const, phase: "executing" as const, workId };
    if (entry.phase === "verified") return { status: "verified" as const, phase: "verified" as const, workId };
    if (entry.phase !== "executed" || !entry.receipt) return { status: "not_ready" as const, reason: "execution_receipt_required", workId };
    if (!entry.receipt.ok) return { status: "not_verified" as const, reason: "provider_reported_failure", workId };
    const result = await options.verifier.verify(entry.proposal, entry.receipt);
    if (result.status !== "verified") return { status: "not_verified" as const, reason: result.reason, workId };
    const evidence = options.work.recordEvidence(workId, {
      kind: result.evidence.kind,
      reference: result.evidence.reference,
      summary: result.evidence.summary,
      recordedAt: result.evidence.recordedAt,
      metadata: result.evidence.metadata ?? undefined,
    });
    options.work.completeObligation(workId);
    update(entry, { phase: "verified" });
    options.telemetry.record({ type: "outcome.verified", workId, idempotencyKey: `outcome.verified:${workId}:${evidence.evidence.id}`, evidenceRef: evidence.evidence.reference, observedAt: evidence.evidence.recordedAt });
    options.telemetry.record({ type: "work.closed", workId, idempotencyKey: `work.closed:${workId}`, observedAt: now(), closureKind: "success" });
    return { status: "verified" as const, phase: "verified" as const, workId };
  }

  function recordStarted(workId: string, workScope: "aws" | "other") {
    options.telemetry.record({ type: "work.started", workId, idempotencyKey: `work.started:${workId}`, observedAt: now(), workScope });
  }
  function recordApprovalRequested(workId: string, key: string) {
    options.telemetry.record({ type: "approval.requested", workId, idempotencyKey: `approval.requested:${workId}:${key}`, observedAt: now(), approvalKey: key });
  }
  function recordApprovalDecision(workId: string, key: string, decision: "approved" | "rejected") {
    options.telemetry.record({ type: "approval.decided", workId, idempotencyKey: `approval.decided:${workId}:${key}:${decision}`, observedAt: now(), approvalKey: key, decision, actor: "human" });
  }
  return { ingest, prepare, decide, execute, reconcile };
}

function loadJournal(file: string): JournalLoadResult {
  if (!existsSync(file)) return { status: "ready", entries: [] };
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const parsed = journalSchema.safeParse(raw);
    if (!parsed.success) return { status: "unavailable" };
    const entries: JournalEntry[] = [];
    const workIds = new Set<string>();
    for (const entry of parsed.data.entries) {
      if (!isWorkEvent(entry.event) || !isValidJournalEntry(entry, entry.event)) return { status: "unavailable" };
      if (workIds.has(entry.workId)) return { status: "unavailable" };
      workIds.add(entry.workId);
      const receipt = entry.receipt === undefined ? undefined : safeReceipt(entry.receipt);
      if (entry.receipt !== undefined && receipt === undefined) return { status: "unavailable" };
      const { receipt: _rawReceipt, ...rest } = entry;
      entries.push(receipt === undefined ? { ...rest, event: entry.event } : { ...rest, event: entry.event, receipt });
    }
    return { status: "ready", entries };
  } catch {
    return { status: "unavailable" };
  }
}

function isValidJournalEntry(entry: z.infer<typeof journalEntrySchema>, event: WorkEvent): boolean {
  if (entry.kind === "capture") return event.type === "capture" && entry.phase === "ingested";
  if (entry.kind === "profile") return event.type === "profile-import" && entry.phase === "ingested" && profileEventHash(event) === event.contentHash;
  if (entry.kind === "worker") {
    if (event.type !== "worker-batch") return false;
    if (entry.phase === "ingested") return entry.workerBatchId === undefined;
    return (entry.phase === "executing" || entry.phase === "dispatched" || entry.phase === "verified" || entry.phase === "rejected")
      && entry.workerBatchId === entry.workId;
  }
  if (event.type !== "action") return false;
  if (entry.phase === "ingested") return entry.proposal === undefined && entry.proposalId === undefined;
  if (entry.proposal === undefined || entry.proposalId !== entry.proposal.id) return false;
  if (entry.phase === "prepared") return entry.approvalId !== undefined;
  if (entry.phase === "approved" || entry.phase === "executing" || entry.phase === "dispatched") return entry.authorizationId !== undefined;
  if (entry.phase === "executed" || entry.phase === "verified") return entry.authorizationId !== undefined && entry.receipt !== undefined;
  return entry.phase === "rejected";
}

function safeReceipt(value: unknown): WorkActionReceipt | undefined {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) return undefined;
  if (parsed.data.observedAt === undefined) return { ok: parsed.data.ok, reference: parsed.data.reference };
  return { ok: parsed.data.ok, reference: parsed.data.reference, observedAt: parsed.data.observedAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWorkEvent(value: unknown): value is WorkEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "worker-batch") return workerEventSchema.safeParse(value).success;
  if (value.type === "profile-import") return profileWorkEventSchema.safeParse(value).success;
  if (value.type === "action") {
    return typeof value.source === "string" && typeof value.externalId === "string" && typeof value.title === "string" &&
      typeof value.ownerId === "string" && typeof value.identity === "string" && typeof value.provider === "string" &&
      typeof value.toolName === "string" && "arguments" in value;
  }
  if (value.type === "capture") {
    return typeof value.source === "string" && typeof value.sourceId === "string" && typeof value.evidenceHash === "string" &&
      typeof value.title === "string" && typeof value.ownerId === "string" && typeof value.evidenceRef === "string";
  }
  if (value.type === "execution-result") {
    return typeof value.workId === "string" && typeof value.proposalId === "string" && typeof value.proposalHash === "string" &&
      typeof value.ok === "boolean" && typeof value.receiptHash === "string" && typeof value.reference === "string";
  }
  return false;
}

function parseWorkEvent(value: unknown): WorkEvent | null {
  const worker = workerEventSchema.safeParse(value);
  if (worker.success) return worker.data;
  const profile = profileWorkEventSchema.safeParse(value);
  if (profile.success) return profile.data;
  return isWorkEvent(value) ? value : null;
}

export function profileEventHash(event: Omit<ProfileWorkEvent, "contentHash"> | ProfileWorkEvent): string {
  const canonical = canonicalizeActionPayload({
    type: event.type,
    source: event.source,
    profileId: event.profileId,
    externalId: event.externalId,
    title: event.title,
    description: event.description ?? null,
    ownerId: event.ownerId,
    ownerLabel: event.ownerLabel ?? null,
    evidence: event.evidence,
    deadline: event.deadline ?? null,
    approval: event.approval ?? null,
    guards: [...event.guards],
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function workerEventHash(event: WorkWorkerEvent): string {
  const canonical = canonicalizeActionPayload({
    type: event.type,
    source: event.source,
    externalId: event.externalId,
    title: event.title,
    ownerId: event.ownerId,
    taskId: event.taskId,
    tasks: event.tasks.map((task) => ({
      key: task.key ?? null,
      label: task.label,
      prompt: task.prompt,
      resumePolicy: task.resumePolicy,
      dependsOn: task.dependsOn === undefined ? null : [...task.dependsOn],
      resourceLocks: task.resourceLocks === undefined ? null : [...task.resourceLocks],
      approvalGate: task.approvalGate ?? null,
      metadata: task.metadata ?? null,
    })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
