import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AccountDirectory } from "./account-directory.ts";
import { ActionPolicy } from "./action-policy.ts";
import { createProviderActionAdapter, type ProviderActionExecutor } from "./provider-action-adapter.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "omb-provider-action-"));
  const policy = new ActionPolicy({ file: join(directory, "policy.db"), defaultOwnerId: "chief" });
  cleanups.push(() => policy.close());
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const accounts = new AccountDirectory({ ownerId: "chief" });
  accounts.reconcile([
    { identity: "Personal", provider: "gmail", accountId: "ca_personal", source: "connected-app", sourceId: "gmail-personal" },
    { identity: "Personal", provider: "calendar", accountId: "ca_calendar", source: "connected-app", sourceId: "calendar-personal" },
  ]);
  return { policy, accounts, adapter: createProviderActionAdapter({ policy, accounts }) };
}

function call(overrides: Partial<Parameters<ReturnType<typeof createProviderActionAdapter>["prepare"]>[0]> = {}) {
  return {
    toolName: "GMAIL_SEND_EMAIL",
    arguments: { account: "ca_personal", to: "friend@example.com", body: "hello" },
    identity: "Personal",
    provider: "gmail",
    ownerId: "chief",
    accountOwnerId: "chief",
    ...overrides,
  };
}

const executor: ProviderActionExecutor = {
  async execute(proposal) { return { ok: true, reference: `receipt:${proposal.proposalHash}` }; },
};

describe("ProviderActionAdapter", () => {
  it("requires an exact identity/account binding before execution", async () => {
    const { adapter } = harness();
    expect(adapter.prepare(call({ arguments: { account: "ca_wrong", to: "x", body: "y" } }))).toMatchObject({ status: "denied" });
    expect(adapter.prepare(call({ identity: "SEF" }))).toMatchObject({ status: "denied" });
  });

  it("keeps policy ownership separate from the installation account owner", () => {
    const { adapter } = harness();
    const prepared = adapter.prepare(call({ ownerId: "bot-chief", accountOwnerId: "chief" }));
    expect(prepared).toMatchObject({ operation: "gmail.send", accountId: "ca_personal" });
  });

  it("fails closed when an identity has multiple exact accounts", () => {
    const { adapter, accounts } = harness();
    accounts.reconcile([
      { identity: "Personal", provider: "gmail", accountId: "ca_second", source: "connected-app", sourceId: "gmail-second" },
    ]);
    expect(adapter.prepare(call())).toMatchObject({ status: "denied", reason: expect.stringMatching(/multiple provider accounts/i) });
  });

  it("fails closed for unknown writes", async () => {
    const { adapter } = harness();
    expect(adapter.prepare(call({ toolName: "GMAIL_SEND_ALL_MAIL" }))).toMatchObject({ status: "denied" });
    expect(await adapter.execute(call({ toolName: "MYSTERY_WRITE" }), executor)).toMatchObject({ status: "denied" });
  });

  it("requires a promoted rule or one-time authorization at the execution seam", async () => {
    const { adapter, policy } = harness();
    const prepared = adapter.prepare(call());
    expect("status" in prepared).toBe(false);
    if ("status" in prepared) return;
    expect(await adapter.execute(call(), executor)).toMatchObject({ status: "denied" });
    const authorization = policy.authorizeOnce(prepared.proposal, {
      approvedBy: "shane", approvalEvidence: "work-approval:send-1", approvedAt: Date.now(),
    });
    const authorized = await adapter.execute(call({ authorizationId: authorization.id }), executor);
    expect(authorized).toMatchObject({ status: "executed", receipt: { ok: true } });
    expect(await adapter.execute(call({ authorizationId: authorization.id }), executor)).toMatchObject({ status: "denied" });
  });

  it("executes only the exact action covered by a standing allow rule", async () => {
    const { adapter, policy } = harness();
    const prepared = adapter.prepare(call());
    if ("status" in prepared) return;
    const candidate = policy.prepareCandidate({ proposal: prepared.proposal, effect: "allow" });
    policy.promoteCandidate(candidate.id, {
      approvedBy: "shane", approvalEvidence: "work-approval:standing-1", approvedAt: Date.now(),
    });
    expect(await adapter.execute(call(), executor)).toMatchObject({ status: "executed" });
    expect(await adapter.execute(call({ arguments: { account: "ca_personal", to: "other@example.com", body: "hello" } }), executor)).toMatchObject({ status: "denied" });
  });

  it("does not execute a changed payload or provider/account combination", async () => {
    const { adapter, policy } = harness();
    const prepared = adapter.prepare(call());
    if ("status" in prepared) return;
    const authorization = policy.authorizeOnce(prepared.proposal, {
      approvedBy: "shane", approvalEvidence: "work-approval:send-2", approvedAt: Date.now(),
    });
    expect(await adapter.execute(call({ arguments: { account: "ca_personal", to: "attacker@example.com", body: "hello" }, authorizationId: authorization.id }), executor)).toMatchObject({ status: "denied" });
    expect(await adapter.execute(call({ provider: "calendar", authorizationId: authorization.id }), executor)).toMatchObject({ status: "denied" });
  });

  it("supports calendar, Drive, and GitHub canonical operations without changing the policy seam", () => {
    const { adapter, accounts } = harness();
    accounts.reconcile([
      { identity: "Personal", provider: "drive", accountId: "ca_drive", source: "connected-app", sourceId: "drive-personal" },
      { identity: "Personal", provider: "github", accountId: "ca_github", source: "connected-app", sourceId: "github-personal" },
    ]);
    for (const [toolName, provider, account] of [
      ["GOOGLECALENDAR_CREATE_EVENT", "calendar", "ca_calendar"],
      ["GOOGLEDRIVE_DELETE_FILE", "drive", "ca_drive"],
      ["GITHUB_CREATE_ISSUE", "github", "ca_github"],
    ] as const) {
      const prepared = adapter.prepare(call({ toolName, provider, arguments: { account, id: "resource-1" } }));
      expect("status" in prepared).toBe(false);
      if (! ("status" in prepared)) expect(prepared.operation).toContain(".");
    }
  });
});
