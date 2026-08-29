import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { AccountDirectory } from "../account-directory.ts";
import { ActionPolicy, type ActionProposal } from "../action-policy.ts";
import { writeFileAtomic } from "../atomic.ts";
import { AutonomyTelemetry } from "../autonomy-telemetry.ts";
import { WorkLockStore } from "../work-lock-store.ts";
import {
  createWorkOrchestrator,
  type WorkActionExecutionResult,
  type WorkActionExecutor,
  type WorkActionVerifier,
  type WorkVerificationResult,
} from "../work-orchestrator.ts";

const draftPayloadSchema = z.object({
  recipient_email: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
});

const mailboxSchema = z.object({
  version: z.literal(1),
  drafts: z.array(z.object({
    id: z.string(),
    accountId: z.string(),
    proposalHash: z.string(),
    recipientEmail: z.string(),
    subject: z.string(),
    body: z.string(),
    createdAt: z.number(),
  })),
});

type MailboxState = z.infer<typeof mailboxSchema>;

export interface FakeGmailProofReceipt {
  readonly exactAccountBound: boolean;
  readonly wrongAccountApprovalRejected: boolean;
  readonly approvedBeforeRestart: boolean;
  readonly executedAfterRestart: boolean;
  readonly duplicateExecutionPrevented: boolean;
  readonly independentlyVerifiedAfterRestart: boolean;
  readonly mailboxDraftCount: number;
  readonly providerCreateCount: number;
  readonly verifierFreshReadCount: number;
  readonly executorRole: "fake-gmail-mutation-adapter";
  readonly verifierRole: "fresh-mailbox-read-adapter";
  readonly completed: boolean;
  readonly workId: string;
  readonly accountId: string;
  readonly proposalHash: string;
  readonly mailboxFile: string;
  readonly journalFile: string;
}

function readMailbox(file: string): MailboxState {
  try {
    const parsed = mailboxSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // A missing fixture mailbox is an empty mailbox, not provider evidence.
  }
  return { version: 1, drafts: [] };
}

function writeMailbox(file: string, state: MailboxState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(state, null, 2), { mode: 0o600 });
}

class FakeGmailExecutor implements WorkActionExecutor {
  readonly accountId: string;
  readonly mailboxFile: string;
  private readonly now: () => number;
  providerCreateCount = 0;

  constructor(input: { accountId: string; mailboxFile: string; now: () => number }) {
    this.accountId = input.accountId;
    this.mailboxFile = input.mailboxFile;
    this.now = input.now;
  }

  async execute(proposal: ActionProposal): Promise<WorkActionExecutionResult> {
    if (proposal.operation !== "gmail.drafts.create") throw new Error("unsupported fake Gmail operation");
    if (proposal.accountId !== this.accountId) throw new Error("fake Gmail account mismatch");
    const payload = draftPayloadSchema.parse(proposal.payload);
    const state = readMailbox(this.mailboxFile);
    const existing = state.drafts.find((draft) => draft.proposalHash === proposal.proposalHash);
    if (existing) {
      return {
        kind: "final",
        receipt: { ok: true, reference: `fake-gmail:draft:${existing.id}` },
      };
    }
    const draft = {
      id: `draft-${proposal.proposalHash.slice(0, 16)}`,
      accountId: proposal.accountId,
      proposalHash: proposal.proposalHash,
      recipientEmail: payload.recipient_email,
      subject: payload.subject,
      body: payload.body,
      createdAt: this.now(),
    };
    this.providerCreateCount += 1;
    writeMailbox(this.mailboxFile, { version: 1, drafts: [...state.drafts, draft] });
    return {
      kind: "final",
      receipt: { ok: true, reference: `fake-gmail:draft:${draft.id}` },
    };
  }
}

class FreshMailboxVerifier implements WorkActionVerifier {
  readonly accountId: string;
  readonly mailboxFile: string;
  private readonly now: () => number;
  freshReadCount = 0;

  constructor(input: { accountId: string; mailboxFile: string; now: () => number }) {
    this.accountId = input.accountId;
    this.mailboxFile = input.mailboxFile;
    this.now = input.now;
  }

  async verify(proposal: ActionProposal): Promise<WorkVerificationResult> {
    this.freshReadCount += 1;
    if (proposal.accountId !== this.accountId) return { status: "not_verified", reason: "account_mismatch" };
    const payload = draftPayloadSchema.safeParse(proposal.payload);
    if (!payload.success) return { status: "not_verified", reason: "payload_invalid" };
    const matches = readMailbox(this.mailboxFile).drafts.filter((draft) =>
      draft.accountId === proposal.accountId &&
      draft.proposalHash === proposal.proposalHash &&
      draft.recipientEmail === payload.data.recipient_email &&
      draft.subject === payload.data.subject &&
      draft.body === payload.data.body
    );
    if (matches.length !== 1) return { status: "not_verified", reason: `expected_one_exact_draft_found_${matches.length}` };
    return {
      status: "verified",
      evidence: {
        kind: "independent-verification",
        reference: `fake-gmail:fresh-read:${matches[0]?.id ?? "missing"}`,
        summary: "A fresh mailbox read found exactly one draft with the approved account and payload.",
        recordedAt: this.now(),
        metadata: { accountId: proposal.accountId, proposalHash: proposal.proposalHash, exactMatches: matches.length },
      },
    };
  }
}

export async function runFakeGmailProof(directory: string): Promise<FakeGmailProofReceipt> {
  const now = new Date("2026-08-28T14:00:00.000Z").getTime();
  const accountId = "ca_fake_gmail_sef";
  const workFile = join(directory, "work.db");
  const policyFile = join(directory, "policy.db");
  const telemetryFile = join(directory, "telemetry.db");
  const journalFile = join(directory, "orchestrator.json");
  const mailboxFile = join(directory, "fake-gmail-mailbox.json");
  mkdirSync(directory, { recursive: true });

  function openRuntime() {
    const accounts = new AccountDirectory({ ownerId: "fixture-owner" });
    accounts.register({
      ownerId: "fixture-owner",
      identity: "SEF-fixture",
      provider: "gmail",
      accountId,
      source: "connected-app",
      sourceId: "fake-gmail-connection",
      evidenceRef: "fixture:fake-gmail:account-binding",
    });
    const work = new WorkLockStore({ file: workFile, now: () => now });
    const policy = new ActionPolicy({ file: policyFile, now: () => now });
    const telemetry = new AutonomyTelemetry({ file: telemetryFile, now: () => now });
    const executor = new FakeGmailExecutor({ accountId, mailboxFile, now: () => now });
    const verifier = new FreshMailboxVerifier({ accountId, mailboxFile, now: () => now });
    const orchestrator = createWorkOrchestrator({
      work,
      accounts,
      policy,
      telemetry,
      executor,
      verifier,
      journalFile,
      now: () => now,
    });
    return { executor, orchestrator, policy, telemetry, verifier, work };
  }

  const first = openRuntime();
  const ingested = first.orchestrator.ingest({
    type: "action",
    source: "fake-gmail-proof",
    externalId: "draft-proof-1",
    title: "Create a synthetic Gmail draft",
    ownerId: "fixture-owner",
    ownerLabel: "Fixture Chief",
    identity: "SEF-fixture",
    provider: "gmail",
    toolName: "GMAIL_CREATE_EMAIL_DRAFT",
    arguments: {
      account_id: accountId,
      recipient_email: "recipient@example.com",
      subject: "Approved fixture subject",
      body: "Approved fixture body",
    },
    requestedBy: "Fixture Chief",
    workScope: "aws",
  });
  if (ingested.status === "denied") throw new Error(`fixture ingestion failed: ${ingested.reason}`);
  if (!("workId" in ingested)) throw new Error("fixture action ingestion did not return one work id");
  const prepared = first.orchestrator.prepare(ingested.workId);
  if (prepared.status !== "prepared") throw new Error(`fixture preparation failed: ${prepared.reason}`);
  const wrongAccountDecision = first.orchestrator.decide({
    workId: ingested.workId,
    approvalId: prepared.approvalId,
    proposalId: prepared.proposal.id,
    proposalHash: prepared.proposal.proposalHash,
    payloadHash: prepared.proposal.payloadHash,
    accountId: "ca_fake_gmail_personal",
    decision: "approved",
    decidedBy: "Fixture Human",
    evidenceRef: "fixture:approval:wrong-account",
  });
  const approved = first.orchestrator.decide({
    workId: ingested.workId,
    approvalId: prepared.approvalId,
    proposalId: prepared.proposal.id,
    proposalHash: prepared.proposal.proposalHash,
    payloadHash: prepared.proposal.payloadHash,
    accountId: prepared.proposal.accountId,
    decision: "approved",
    decidedBy: "Fixture Human",
    evidenceRef: "fixture:approval:exact-account-and-payload",
  });
  first.work.close();
  first.policy.close();
  first.telemetry.close();

  const second = openRuntime();
  const executed = await second.orchestrator.execute(ingested.workId);
  const providerCreateCount = second.executor.providerCreateCount;
  second.work.close();
  second.policy.close();
  second.telemetry.close();

  const third = openRuntime();
  const duplicate = await third.orchestrator.execute(ingested.workId);
  const reconciled = await third.orchestrator.reconcile(ingested.workId);
  const verifierFreshReadCount = third.verifier.freshReadCount;
  const completed = third.work.getObligation(ingested.workId)?.status === "completed";
  third.work.close();
  third.policy.close();
  third.telemetry.close();

  const mailbox = readMailbox(mailboxFile);
  return {
    exactAccountBound: prepared.proposal.accountId === accountId,
    wrongAccountApprovalRejected: wrongAccountDecision.status === "denied",
    approvedBeforeRestart: approved.status === "approved",
    executedAfterRestart: executed.status === "executed",
    duplicateExecutionPrevented: duplicate.status === "replay_prevented",
    independentlyVerifiedAfterRestart: reconciled.status === "verified",
    mailboxDraftCount: mailbox.drafts.length,
    providerCreateCount,
    verifierFreshReadCount,
    executorRole: "fake-gmail-mutation-adapter",
    verifierRole: "fresh-mailbox-read-adapter",
    completed,
    workId: ingested.workId,
    accountId,
    proposalHash: prepared.proposal.proposalHash,
    mailboxFile,
    journalFile,
  };
}
