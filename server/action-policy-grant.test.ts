import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ActionPolicy } from "./action-policy.ts";
import {
  actionPolicyAllowKey,
  rememberExactAction,
  REMEMBER_EXACT_ACTION_MS,
} from "./action-policy-grant.ts";

const directories: string[] = [];
const policies: ActionPolicy[] = [];

afterEach(() => {
  for (const policy of policies.splice(0)) policy.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function harness(now: number) {
  const directory = mkdtempSync(join(tmpdir(), "centipede-policy-grant-"));
  directories.push(directory);
  const policy = new ActionPolicy({ file: join(directory, "policy.db"), now: () => now });
  policies.push(policy);
  return policy;
}

describe("rememberExactAction", () => {
  it("promotes only the referenced owner's exact proposal and expires it after 30 days", () => {
    const now = 1_756_000_000_000;
    const policy = harness(now);
    const proposal = policy.prepare({
      operation: "gmail.drafts.create",
      accountId: "ca_personal",
      ownerId: "chief",
      payload: { to: ["friend@example.com"], subject: "Hello", body: "Draft body" },
    });

    const rule = rememberExactAction(policy, actionPolicyAllowKey(proposal.id), {
      expectedOwnerId: "chief",
      approvedBy: "shane",
      approvalEvidence: "work-approval:approval-1",
      approvedAt: now,
      now,
    });

    expect(rule).toMatchObject({
      effect: "allow",
      ownerId: "chief",
      expiresAt: now + REMEMBER_EXACT_ACTION_MS,
    });
    expect(policy.evaluate(proposal, { now: now + REMEMBER_EXACT_ACTION_MS - 1 }).effect).toBe("allow");
    expect(policy.evaluate(proposal, { now: now + REMEMBER_EXACT_ACTION_MS }).effect).toBe("ask");
  });

  it("rejects a forged key, a missing proposal, and a different owner", () => {
    const now = 1_756_000_000_000;
    const policy = harness(now);
    const proposal = policy.prepare({
      operation: "gmail.drafts.create",
      accountId: "ca_personal",
      ownerId: "chief",
      payload: { to: ["friend@example.com"], subject: "Hello", body: "Draft body" },
    });
    const approval = {
      expectedOwnerId: "capture",
      approvedBy: "shane",
      approvalEvidence: "work-approval:approval-1",
      approvedAt: now,
      now,
    } as const;

    expect(() => rememberExactAction(policy, "Bash:git status", approval)).toThrow(/grant key/i);
    expect(() => rememberExactAction(policy, actionPolicyAllowKey("missing"), approval)).toThrow(/not found/i);
    expect(() => rememberExactAction(policy, actionPolicyAllowKey(proposal.id), approval)).toThrow(/owner/i);
  });
});
