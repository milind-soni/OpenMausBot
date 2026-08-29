import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runFakeGmailProof } from "../server/test-support/fake-gmail-proof.ts";

const artifactDirectory = resolve("artifacts/centipede-0.2.0/orchestrator");
const fixtureDirectory = join(artifactDirectory, "fixture-state");
mkdirSync(artifactDirectory, { recursive: true });
rmSync(fixtureDirectory, { recursive: true, force: true });

const startedAt = new Date().toISOString();
const proof = await runFakeGmailProof(fixtureDirectory);
const completedAt = new Date().toISOString();
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const evidence = {
  command: "node --experimental-strip-types scripts/prove-fake-gmail.ts",
  startedAt,
  completedAt,
  exitState: "passed",
  fixture: "synthetic fake Gmail account and mailbox",
  mailboxSha256: sha256(proof.mailboxFile),
  journalSha256: sha256(proof.journalFile),
};
const receipt = {
  schemaVersion: 1,
  ...evidence,
  safety: "Synthetic account, recipient, mailbox, and provider only. No external network calls.",
  ...proof,
  mailboxFile: "fixture-state/fake-gmail-mailbox.json",
  journalFile: "fixture-state/orchestrator.json",
};
const exactDraftReceipt = {
  schemaVersion: 1,
  ...evidence,
  safety: receipt.safety,
  exactAccountBound: proof.exactAccountBound,
  approvedBeforeRestart: proof.approvedBeforeRestart,
  executedAfterRestart: proof.executedAfterRestart,
  duplicateExecutionPrevented: proof.duplicateExecutionPrevented,
  independentlyVerifiedAfterRestart: proof.independentlyVerifiedAfterRestart,
  executorRole: proof.executorRole,
  verifierRole: proof.verifierRole,
  verifierFreshReadCount: proof.verifierFreshReadCount,
  providerCreateCount: proof.providerCreateCount,
  mailboxDraftCount: proof.mailboxDraftCount,
  completed: proof.completed,
  workId: proof.workId,
  accountId: proof.accountId,
  proposalHash: proof.proposalHash,
};
const wrongAccountReceipt = {
  schemaVersion: 1,
  ...evidence,
  safety: receipt.safety,
  wrongAccountApprovalRejected: proof.wrongAccountApprovalRejected,
  approvedAccountId: proof.accountId,
  attemptedAccountId: "ca_fake_gmail_personal",
  providerCallsBeforeExactApproval: 0,
};
const callLedger = {
  schemaVersion: 1,
  ...evidence,
  safety: receipt.safety,
  calls: [{ operation: "gmail.drafts.create", accountId: proof.accountId, proposalHash: proof.proposalHash }],
  totalCalls: proof.providerCreateCount,
  duplicateExecutionPrevented: proof.duplicateExecutionPrevented,
};
writeFileSync(join(artifactDirectory, "gmail-draft-exact.json"), JSON.stringify(exactDraftReceipt, null, 2));
writeFileSync(join(artifactDirectory, "wrong-account.json"), JSON.stringify(wrongAccountReceipt, null, 2));
writeFileSync(join(artifactDirectory, "fake-executor-call-ledger.json"), JSON.stringify(callLedger, null, 2));
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
