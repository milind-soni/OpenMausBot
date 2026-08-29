import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkLockError, WorkLockStore, type WorkLockStoreInterface } from "./work-lock-store.ts";

const directories: string[] = [];
const stores: WorkLockStoreInterface[] = [];

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "omb-work-lock-"));
  directories.push(directory);
  let now = 10_000;
  const store = new WorkLockStore({ file: join(directory, "locks.db"), now: () => now });
  stores.push(store);
  return { store, setNow: (value: number) => { now = value; } };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const input = (overrides: Partial<Parameters<WorkLockStoreInterface["createObligation"]>[0]> = {}) => ({
  title: "Send the signed agreement",
  source: "crm",
  externalId: "deal-42",
  description: "Return the final signed copy to the counterparty.",
  ...overrides,
});

describe("WorkLockStore", () => {
  it("creates a durable obligation and deduplicates the same external identity", () => {
    const { store } = harness();
    const first = store.createObligation(input({ metadata: { priority: "high" } }));
    const second = store.createObligation(input({ title: "A changed title from the same source" }));

    expect(first.status).toBe("created");
    expect(second.status).toBe("deduplicated");
    expect(second.obligation.id).toBe(first.obligation.id);
    expect(second.obligation.title).toBe("Send the signed agreement");
    expect(second.obligation.externalIdentity).toEqual({ source: "crm", id: "deal-42" });
    expect(second.obligation.version).toBe(1);
  });

  it("persists relations and state across a store restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-work-lock-restart-"));
    directories.push(directory);
    const file = join(directory, "locks.db");
    let now = 1_000;
    const first = new WorkLockStore({ file, now: () => now });
    stores.push(first);
    const created = first.createObligation(input({ externalId: "restart-1", deadline: { key: "sign-by", label: "Sign by Friday", dueAt: 2_000 } }));
    const approval = first.addApproval(created.obligation.id, { key: "send", prompt: "May I send this agreement?", payload: { recipient: "legal@example.test", amount: 1200 } });
    first.recordEvidence(created.obligation.id, { kind: "file", reference: "file:///signed.pdf", summary: "Signature was checked locally." }, approval.obligation.version);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const second = new WorkLockStore({ file, now: () => now });
    stores.push(second);
    const restored = second.getObligation(created.obligation.id);
    expect(restored).toMatchObject({ status: "open", version: 3, approvals: [{ status: "pending", payloadHash: expect.any(String) }], deadlines: [{ key: "sign-by" }], evidence: [{ reference: "file:///signed.pdf" }] });

    now = 3_000;
    expect(second.listOpenWork().deadlines[0]?.status).toBe("missed");
  });

  it("rejects stale writes with optimistic versioning", () => {
    const { store } = harness();
    const created = store.createObligation(input({ externalId: "version-1" }));
    const updated = store.updateObligation(created.obligation.id, { title: "Current title", expectedVersion: 1 });
    expect(updated.version).toBe(2);
    expect(() => store.updateObligation(created.obligation.id, { title: "Stale title", expectedVersion: 1 })).toThrowError(
      expect.objectContaining({ code: "version_conflict", status: 409 }),
    );
    expect(store.getObligation(created.obligation.id)?.title).toBe("Current title");
  });

  it("enforces lifecycle legality and blocks completion while approval is pending", () => {
    const { store } = harness();
    const created = store.createObligation(input({ externalId: "lifecycle-1" }));
    const approval = store.addApproval(created.obligation.id, { key: "publish", prompt: "Approve publication" });
    expect(() => store.completeObligation(created.obligation.id, approval.obligation.version)).toThrowError(
      expect.objectContaining({ code: "approval_pending" }),
    );
    const rejected = store.decideApproval(created.obligation.id, approval.approval.id, "rejected", "reviewer", approval.obligation.version);
    expect(() => store.completeObligation(created.obligation.id, rejected.obligation.version)).toThrowError(
      expect.objectContaining({ code: "evidence_required" }),
    );
    const evidence = store.recordEvidence(created.obligation.id, {
      kind: "decision",
      reference: "review:publish",
      summary: "The reviewer rejected publication.",
    }, rejected.obligation.version);
    const completed = store.completeObligation(created.obligation.id, evidence.obligation.version);
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe(10_000);
    expect(() => store.transitionObligation(completed.id, "open", completed.version)).toThrowError(
      expect.objectContaining({ code: "illegal_transition" }),
    );
    expect(() => store.recordEvidence(completed.id, {
      kind: "late",
      reference: "late-write",
      summary: "Must not mutate terminal work",
    }, completed.version)).toThrowError(expect.objectContaining({ code: "illegal_transition" }));
  });

  it("deduplicates evidence and approvals while projecting only open work", () => {
    const { store } = harness();
    const first = store.createObligation(input({ externalId: "open-1", ownerId: "alex" }));
    const second = store.createObligation(input({ externalId: "closed-1", ownerId: "alex" }));
    const evidence = store.recordEvidence(first.obligation.id, { kind: "receipt", reference: "receipt-1", summary: "Observed" });
    const duplicateEvidence = store.recordEvidence(first.obligation.id, { kind: "receipt", reference: "receipt-1", summary: "Observed again" }, evidence.obligation.version);
    expect(duplicateEvidence.status).toBe("deduplicated");
    const approval = store.addApproval(first.obligation.id, {
      key: "ship",
      prompt: "Ship it",
      payload: { recipient: "private@example.test", body: "sensitive" },
    }, duplicateEvidence.obligation.version);
    const duplicateApproval = store.addApproval(first.obligation.id, { key: "ship", prompt: "A repeated card" }, approval.obligation.version);
    expect(duplicateApproval.status).toBe("deduplicated");
    store.cancelObligation(second.obligation.id);

    const projection = store.listOpenWork({ ownerId: "alex" });
    expect(projection.obligations.map((obligation) => obligation.id)).toEqual([first.obligation.id]);
    expect(projection.pendingApprovals).toHaveLength(1);
    expect(projection.pendingApprovals[0]).toMatchObject({ payload: null, payloadHash: expect.any(String) });
    expect(projection.obligations[0]?.evidence).toHaveLength(1);
  });

  it("does not silently accept malformed boundaries", () => {
    const { store } = harness();
    expect(() => store.createObligation(input({ title: "   " }))).toThrow();
    expect(() => store.addDeadline("missing", { label: "Due", dueAt: 2_000 })).toThrowError(WorkLockError);
  });
});
