import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runFakeGmailProof } from "./test-support/fake-gmail-proof.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("fake Gmail end-to-end proof", () => {
  it("binds approval to the exact account, survives restarts, and creates one draft", async () => {
    const directory = mkdtempSync(join(tmpdir(), "centipede-fake-gmail-proof-"));
    directories.push(directory);

    await expect(runFakeGmailProof(directory)).resolves.toMatchObject({
      exactAccountBound: true,
      wrongAccountApprovalRejected: true,
      approvedBeforeRestart: true,
      executedAfterRestart: true,
      duplicateExecutionPrevented: true,
      independentlyVerifiedAfterRestart: true,
      mailboxDraftCount: 1,
      providerCreateCount: 1,
      verifierFreshReadCount: 1,
      executorRole: "fake-gmail-mutation-adapter",
      verifierRole: "fresh-mailbox-read-adapter",
      completed: true,
      accountId: "ca_fake_gmail_sef",
    });
  });
});
