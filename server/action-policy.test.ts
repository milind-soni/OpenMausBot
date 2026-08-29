import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ActionPolicy, hashActionPayload } from "./action-policy.ts";
import type { ActionApprovalEvidence } from "./action-policy.ts";

const dirs: string[] = [];
const policies: ActionPolicy[] = [];

afterEach(() => {
  for (const policy of policies.splice(0)) {
    try { policy.close(); } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-action-policy-"));
  dirs.push(dir);
  let now = 1_756_000_000_000;
  const policy = new ActionPolicy({ file: join(dir, "action-policy.db"), now: () => now });
  policies.push(policy);
  return { policy, setNow: (value: number) => { now = value; }, file: join(dir, "action-policy.db") };
}

function proposal(policy: ActionPolicy, overrides: Partial<Parameters<ActionPolicy["prepareProposal"]>[0]> = {}) {
  return policy.prepareProposal({
    operation: "gmail.send",
    accountId: "personal:gmail",
    payload: { to: "friend@example.com", body: "hello", labels: ["personal"] },
    ...overrides,
  });
}

const approval = (suffix: string): ActionApprovalEvidence => ({
  approvedBy: "shane",
  approvalEvidence: `work-approval:${suffix}`,
  approvedAt: 1_755_999_999_000,
});

describe("ActionPolicy", () => {
  it("migrates approval binding columns on an existing policy database", () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-action-policy-migration-"));
    dirs.push(directory);
    const file = join(directory, "action-policy.db");
    const oldDb = new DatabaseSync(file);
    oldDb.exec(`
      CREATE TABLE action_rule_candidates (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        account_hash TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        proposal_hash TEXT NOT NULL,
        effect TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        expires_at INTEGER,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    oldDb.close();

    const policy = new ActionPolicy({ file, now: () => 1_756_000_000_000 });
    policies.push(policy);
    const prepared = proposal(policy);
    const candidate = policy.prepareCandidate({ proposal: prepared, effect: "allow" });
    policy.promoteCandidate(candidate.id, approval("migration"));

    expect(policy.getCandidate(candidate.id)).toMatchObject({
      approvedBy: "shane",
      approvalEvidence: "work-approval:migration",
      approvedAt: 1_755_999_999_000,
    });
    expect(policy.listRules()[0]).toMatchObject({
      approvedBy: "shane",
      approvalEvidence: "work-approval:migration",
      approvedAt: 1_755_999_999_000,
    });
  });

  it("keeps candidates pending until an explicit promotion or rejection", () => {
    const { policy } = harness();
    const prepared = proposal(policy);
    const candidate = policy.prepareCandidate({
      proposal: prepared,
      effect: "allow",
      reason: "Draft this sender's routine replies for review",
    });

    expect(policy.getCandidate(candidate.id)).toMatchObject({ id: candidate.id, status: "pending" });
    expect(policy.listCandidates({ status: "pending" }).map((item) => item.id)).toEqual([candidate.id]);
    expect(policy.evaluate(prepared).effect).toBe("ask");
    expect(() => Reflect.apply(policy.promoteCandidate, policy, [candidate.id])).toThrow(/explicit approval/i);

    const rejected = policy.rejectCandidate(candidate.id);
    expect(rejected).toMatchObject({ id: candidate.id, status: "rejected" });
    expect(policy.getCandidate(candidate.id)?.status).toBe("rejected");
    expect(policy.listCandidates({ status: "pending" })).toEqual([]);
    expect(policy.listCandidates({ status: "rejected" }).map((item) => item.id)).toEqual([candidate.id]);
    expect(policy.evaluate(prepared).effect).toBe("ask");
    expect(() => policy.promoteCandidate(candidate.id, approval("rejected"))).toThrow(/no longer pending/);
  });

  it("lists promoted candidates and preserves them across restart", () => {
    const first = harness();
    const prepared = proposal(first.policy);
    const candidate = first.policy.prepareCandidate({ proposal: prepared, effect: "draft-only" });
    first.policy.promoteCandidate(candidate.id, approval(candidate.id));
    expect(first.policy.listCandidates({ status: "promoted" })).toMatchObject([{
      id: candidate.id,
      status: "promoted",
      approvedBy: "shane",
      approvalEvidence: `work-approval:${candidate.id}`,
      approvedAt: 1_755_999_999_000,
    }]);

    first.policy.close();
    policies.splice(policies.indexOf(first.policy), 1);
    const reopened = new ActionPolicy({ file: first.file, now: () => 1_756_000_000_000 });
    policies.push(reopened);
    expect(reopened.getCandidate(candidate.id)).toMatchObject({ proposalId: prepared.id, status: "promoted" });
  });

  it("requires an exact proposal and revalidates unmodified execution", () => {
    const { policy } = harness();
    const prepared = proposal(policy);
    const candidate = policy.prepareCandidate({ proposal: prepared, effect: "allow" });
    const rule = policy.promoteCandidate(candidate.id, approval(candidate.id));

    expect(policy.evaluate(prepared).effect).toBe("allow");
    expect(policy.revalidate(prepared, {
      operation: "gmail.send",
      accountId: "personal:gmail",
      payload: { labels: ["personal"], body: "hello", to: "friend@example.com" },
    }).effect).toBe("allow");
    expect(rule.payloadHash).toBe(hashActionPayload(prepared.payload));
  });

  it("consumes an exact one-time authorization only once", () => {
    const { policy } = harness();
    const prepared = proposal(policy);
    const authorization = policy.authorizeOnce(prepared, approval("once"));

    expect(policy.getAuthorization(authorization.id)).toMatchObject({ state: "active" });
    expect(policy.consumeAuthorization(authorization.id, {
      operation: prepared.operation,
      accountId: prepared.accountId,
      payload: prepared.payload,
      ownerId: prepared.ownerId,
    })).toMatchObject({ effect: "allow", allowed: true });
    expect(policy.getAuthorization(authorization.id)).toMatchObject({ state: "consumed" });
    expect(policy.consumeAuthorization(authorization.id, prepared)).toMatchObject({ effect: "deny", allowed: false });
  });

  it("does not consume a one-time authorization for changed bytes or account", () => {
    const { policy } = harness();
    const prepared = proposal(policy);
    const authorization = policy.authorizeOnce(prepared, approval("exact"));

    expect(policy.consumeAuthorization(authorization.id, {
      operation: prepared.operation,
      accountId: "work:gmail",
      payload: prepared.payload,
      ownerId: prepared.ownerId,
    })).toMatchObject({ effect: "deny", allowed: false });
    expect(policy.getAuthorization(authorization.id)).toMatchObject({ state: "active" });
  });

  it("binds execution to the approved proposal identity and owner", () => {
    const { policy } = harness();
    const prepared = proposal(policy, { ownerId: "chief-a" });
    policy.promoteCandidate(policy.prepareCandidate({ proposal: prepared, effect: "allow" }).id, approval("owner-a"));
    const sameAction = proposal(policy, { ownerId: "chief-b" });

    expect(policy.revalidate(prepared, sameAction)).toMatchObject({ effect: "deny", allowed: false });
  });

  it("fails closed when payload or account is tampered with", () => {
    const { policy } = harness();
    const prepared = proposal(policy);
    policy.promoteCandidate(policy.prepareCandidate({ proposal: prepared, effect: "allow" }).id, approval("tamper"));

    expect(policy.revalidate(prepared, {
      operation: "gmail.send",
      accountId: "personal:gmail",
      payload: { to: "attacker@example.com", body: "hello", labels: ["personal"] },
    })).toMatchObject({ effect: "deny", allowed: false });
    expect(policy.revalidate(prepared, {
      operation: "gmail.send",
      accountId: "work:gmail",
      payload: prepared.payload,
    })).toMatchObject({ effect: "deny", allowed: false });
    const forged = { ...prepared, payload: { to: "attacker@example.com" } };
    expect(policy.revalidate(prepared, forged)).toMatchObject({ effect: "deny", allowed: false });
  });

  it("does not use expired rules and gives deny precedence over allow", () => {
    const { policy, setNow } = harness();
    const prepared = proposal(policy);
    policy.promoteCandidate(policy.prepareCandidate({ proposal: prepared, effect: "allow", expiresAt: 1_756_000_000_100 }).id, approval("expiry"));
    setNow(1_756_000_000_101);
    expect(policy.evaluate(prepared).effect).toBe("ask");

    policy.promoteCandidate(policy.prepareCandidate({ proposal: prepared, effect: "allow" }).id, approval("allow"));
    policy.promoteCandidate(policy.prepareCandidate({ proposal: prepared, effect: "deny" }).id, approval("deny"));
    expect(policy.evaluate(prepared)).toMatchObject({ effect: "deny", allowed: false });
  });

  it("keeps rule versions and revocation durable across restart", () => {
    const first = harness();
    const prepared = proposal(first.policy);
    const firstRule = first.policy.promoteCandidate(first.policy.prepareCandidate({ proposal: prepared, effect: "allow" }).id, approval("restart"));
    expect(firstRule.version).toBe(1);
    first.policy.close();
    policies.splice(policies.indexOf(first.policy), 1);

    const reopened = new ActionPolicy({ file: first.file, now: () => 1_756_000_000_000 });
    policies.push(reopened);
    const loaded = reopened.getProposal(prepared.id);
    expect(loaded?.proposalHash).toBe(prepared.proposalHash);
    expect(reopened.evaluate(loaded ?? prepared).effect).toBe("allow");
    expect(reopened.revokeRule(firstRule.id)).toBe(true);
    expect(reopened.evaluate(loaded ?? prepared).effect).toBe("ask");
  });

  it("rejects broad operation and account scopes", () => {
    const { policy } = harness();
    expect(() => policy.prepareProposal({ operation: "*", accountId: "personal:gmail", payload: {} })).toThrow(/exact/);
    expect(() => policy.prepareProposal({ operation: "gmail.send", accountId: "any", payload: {} })).toThrow(/exact/);
  });

  it("does not share an exact rule across owners", () => {
    const { policy } = harness();
    const ownerA = proposal(policy, { ownerId: "chief-a" });
    policy.promoteCandidate(policy.prepareCandidate({ proposal: ownerA, effect: "allow" }).id, approval("owner-a"));
    const ownerB = proposal(policy, { ownerId: "chief-b" });
    expect(policy.evaluate(ownerA).effect).toBe("allow");
    expect(policy.evaluate(ownerB).effect).toBe("ask");
  });
});
