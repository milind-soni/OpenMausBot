import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";

// server/testing/setup.ts gives every worker a throwaway HOME before imports;
// keeping DATA_DIR at its default still isolates this private file from live
// app data while avoiding a module-cache race with config.ts.

const {
  deleteBot,
  deleteThread,
  invalidateInstance,
  invalidateBot,
  invalidateGroup,
  invalidateOwner,
  markDispatched,
  planRoomTurn,
  recordSession,
  settle,
  usesInstance,
} = await import("./room-continuations.ts");
const { acpInstructionReceiptPath, writeAcpInstructionReceipt } = await import("./drivers/acp/instruction-receipts.ts");

const owner = { groupId: "group-a", threadId: "thread-a", botId: "bot-a" };
const selection = { instanceId: "acp-a", model: "model-a" };
const context = (ids: string[], deltaText = "delta") => ({
  owner,
  selection,
  fullText: "full",
  recoveryText: "full",
  eligibleMessageIds: ids,
  deltaFor: (anchor?: string) => ({
    text: deltaText,
    anchorFound: anchor === ids[0],
    eligibleMessages: Math.max(0, ids.length - 1),
    sentMessages: Math.max(0, ids.length - 1),
  }),
});
const records = () => JSON.parse(readFileSync(join(process.env.HOME!, ".openmausbot", "room-continuations.json"), "utf8")).records;
const initialContinuity = process.env.OMB_ROOM_SESSION_CONTINUITY;

// Invalidation is intentionally feature-flagged. Keep the module-level unit
// cases on the enabled path, while each test restores the worker's original
// environment for rollback coverage and other suites.
beforeEach(() => {
  process.env.OMB_ROOM_SESSION_CONTINUITY = "1";
});
afterEach(() => {
  if (initialContinuity === undefined) delete process.env.OMB_ROOM_SESSION_CONTINUITY;
  else process.env.OMB_ROOM_SESSION_CONTINUITY = initialContinuity;
});

describe("room continuation planning", () => {
  it("commits a cursor only after settlement, then resumes from the anchor", () => {
    const first = planRoomTurn(context(["m1"]));
    expect(first).toMatchObject({ mode: "fresh", reason: "new", text: "full" });
    markDispatched(first);
    recordSession(owner, selection.instanceId, "session-a");
    expect(records()[0]?.deliveredEligibleMessages).toBe(0);
    settle(first, "settled");

    const next = planRoomTurn(context(["m1", "m2"]));
    expect(next).toMatchObject({ mode: "resume", reason: "resume", resumeCursor: "session-a", text: "delta" });
    expect(next.recoveryText).toBe("full");
    expect(next.deliveredEligibleMessages).toBe(2);
    settle(next, "provider_failed");
    expect(planRoomTurn(context(["m1", "m2"])).reason).toBe("cursor-missing");
  });

  it("rotates an uncertain restart and does not auto-replay in-flight work", () => {
    const fresh = planRoomTurn(context(["r1"]));
    markDispatched(fresh);
    const restarted = planRoomTurn(context(["r1", "r2"]));
    expect(restarted).toMatchObject({ mode: "rotate", reason: "restart-uncertain" });
  });

  it("rebuilds when the anchor disappears and rotates when the window would exceed 30", () => {
    // Use an independent owner so the restart test's in-flight marker cannot
    // affect this branch.
    const other = { groupId: "group-b", threadId: "thread-b", botId: "bot-b" };
    const input = (ids: string[]) => ({ ...context(ids), owner: other });
    const first = planRoomTurn(input(["a"]));
    markDispatched(first);
    recordSession(other, selection.instanceId, "session-b");
    settle(first, "settled");
    const missing = planRoomTurn({ ...input(["b"]), deltaFor: () => ({ text: "delta", anchorFound: false, eligibleMessages: 0, sentMessages: 0 }) });
    expect(missing.reason).toBe("anchor-missing");

    const rotatedOwner = { groupId: "group-c", threadId: "thread-c", botId: "bot-c" };
    const many = (count: number) => ({ ...context(Array.from({ length: count }, (_, i) => `m${i}`)), owner: rotatedOwner,
      deltaFor: () => ({ text: "delta", anchorFound: true, eligibleMessages: 1, sentMessages: 1 }) });
    const initial = planRoomTurn(many(30));
    markDispatched(initial);
    recordSession(rotatedOwner, selection.instanceId, "session-c");
    settle(initial, "settled");
    const rotated = planRoomTurn(many(31));
    expect(rotated).toMatchObject({ mode: "rotate", reason: "window-rotated" });
  });

  it("keeps the old selection identity so a model change is planned explicitly", () => {
    const changedOwner = { groupId: "group-model", threadId: "thread-model", botId: "bot-model" };
    const initial = planRoomTurn({ ...context(["m1"]), owner: changedOwner });
    markDispatched(initial);
    recordSession(changedOwner, selection.instanceId, "session-model");
    settle(initial, "settled");

    invalidateBot(changedOwner.botId);
    const changed = planRoomTurn({
      ...context(["m1", "m2"]),
      owner: changedOwner,
      selection: { instanceId: selection.instanceId, model: "model-b" },
    });
    expect(changed).toMatchObject({ mode: "fresh", reason: "model-changed" });
  });

  it("fences invalidation races before dispatch and before session binding", () => {
    const raced = { groupId: "group-race", threadId: "thread-race", botId: "bot-race" };
    const first = planRoomTurn({ ...context(["r1"]), owner: raced });
    invalidateBot(raced.botId);
    expect(markDispatched(first)).toBe(false);

    const second = planRoomTurn({ ...context(["r1"]), owner: raced });
    expect(markDispatched(second)).toBe(true);
    invalidateBot(raced.botId);
    recordSession(raced, selection.instanceId, "stale-session", second);
    settle(second, "settled");
    const after = planRoomTurn({ ...context(["r1", "r2"]), owner: raced });
    expect(after).toMatchObject({ mode: "fresh", reason: "cursor-missing" });
    expect(after.resumeCursor).toBeUndefined();
  });

  it("fences a first room plan when group authority changes before dispatch", () => {
    const raced = { groupId: "group-first-turn-race", threadId: "thread-first-turn-race", botId: "bot-first-turn-race" };
    const first = planRoomTurn({ ...context(["first-race"]), owner: raced });
    invalidateGroup(raced.groupId);
    expect(markDispatched(first)).toBe(false);
    const replacement = planRoomTurn({ ...context(["first-race"]), owner: raced });
    expect(markDispatched(replacement)).toBe(true);
    settle(replacement, "provider_failed");
  });

  it("rejects a provider plan that races a successful instance mutation", () => {
    const raced = { groupId: "group-instance-race", threadId: "thread-instance-race", botId: "bot-instance-race" };
    const instanceId = "instance-race";
    const plan = planRoomTurn({
      ...context(["instance-race"]),
      owner: raced,
      selection: { instanceId, model: "model" },
    });
    const previous = process.env.OMB_ROOM_SESSION_CONTINUITY;
    try {
      process.env.OMB_ROOM_SESSION_CONTINUITY = "1";
      invalidateInstance(instanceId);
      expect(markDispatched(plan)).toBe(false);
      expect(records().some((record: any) => record.threadId === raced.threadId)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OMB_ROOM_SESSION_CONTINUITY;
      else process.env.OMB_ROOM_SESSION_CONTINUITY = previous;
    }
  });

  it.each([
    ["bot then provider", "bot", "instance"],
    ["bot then group", "bot", "group"],
    ["provider then bot", "instance", "bot"],
    ["owner then thread deletion", "owner", "thread"],
  ])("rejects a stale plan after a cross-scope invalidation: %s", (_name, firstScope, secondScope) => {
    const suffix = `${firstScope}-${secondScope}-${Math.random().toString(36).slice(2)}`;
    const raced = { groupId: `group-epoch-${suffix}`, threadId: `thread-epoch-${suffix}`, botId: `bot-epoch-${suffix}` };
    const instanceId = `instance-epoch-${suffix}`;
    const input = {
      ...context([`epoch-${suffix}`]),
      owner: raced,
      selection: { instanceId, model: "model" },
    };
    const stale = planRoomTurn(input);

    for (let index = 0; index < 5; index += 1) {
      if (firstScope === "bot") invalidateBot(raced.botId);
      else if (firstScope === "instance") invalidateInstance(instanceId);
      else invalidateOwner(raced, "epoch-test");
    }
    if (secondScope === "instance") invalidateInstance(instanceId);
    else if (secondScope === "group") invalidateGroup(raced.groupId);
    else if (secondScope === "bot") invalidateBot(raced.botId);
    else {
      invalidateOwner(raced, "epoch-test");
      deleteThread(raced.groupId, raced.threadId);
    }

    expect(markDispatched(stale)).toBe(false);
    recordSession(raced, instanceId, "stale-session", stale);
    settle(stale, "settled");
    expect(records().some((record: any) => record.threadId === raced.threadId && Object.keys(record.cursors).length > 0)).toBe(false);

    const unrelated = {
      groupId: `group-unrelated-${suffix}`,
      threadId: `thread-unrelated-${suffix}`,
      botId: `bot-unrelated-${suffix}`,
    };
    const unrelatedPlan = planRoomTurn({ ...context([`unrelated-${suffix}`]), owner: unrelated });
    expect(markDispatched(unrelatedPlan)).toBe(true);
    settle(unrelatedPlan, "provider_failed");
  });

  it("rejects a resumed plan after a lower-counter provider invalidation", () => {
    const raced = { groupId: "group-resumed-epoch", threadId: "thread-resumed-epoch", botId: "bot-resumed-epoch" };
    const instanceId = "instance-resumed-epoch";
    const first = planRoomTurn({ ...context(["resumed-1"]), owner: raced, selection: { instanceId, model: "model" } });
    expect(markDispatched(first)).toBe(true);
    recordSession(raced, instanceId, "resumed-session", first);
    settle(first, "settled");
    const stale = planRoomTurn({
      ...context(["resumed-1", "resumed-2"]),
      owner: raced,
      selection: { instanceId, model: "model" },
    });
    expect(stale.mode).toBe("resume");
    for (let index = 0; index < 5; index += 1) invalidateBot(`unrelated-epoch-bot-${index}`);
    invalidateInstance(instanceId);
    expect(markDispatched(stale)).toBe(false);
    recordSession(raced, instanceId, "stale-resumed-session", stale);
    settle(stale, "settled");
    const stored = records().find((record: any) => record.threadId === raced.threadId);
    expect(stored?.cursors).toEqual({});
    expect(stored?.deliveredThroughMessageId).toBeUndefined();
  });

  it("keeps two room tasks for the same bot isolated", () => {
    const firstOwner = { groupId: "group-isolated", threadId: "thread-one", botId: "bot-isolated" };
    const secondOwner = { groupId: "group-isolated", threadId: "thread-two", botId: "bot-isolated" };
    const first = planRoomTurn({ ...context(["one"]), owner: firstOwner });
    const second = planRoomTurn({ ...context(["two"]), owner: secondOwner });
    expect(first.resumeCursor).toBeUndefined();
    expect(second.resumeCursor).toBeUndefined();
    markDispatched(first);
    recordSession(firstOwner, selection.instanceId, "session-one", first);
    settle(first, "settled");
    const nextFirst = planRoomTurn({ ...context(["one", "one-next"]), owner: firstOwner });
    const nextSecond = planRoomTurn({ ...context(["two", "two-next"]), owner: secondOwner });
    expect(nextFirst.resumeCursor).toBe("session-one");
    expect(nextSecond.resumeCursor).toBeUndefined();
    settle(nextFirst, "provider_failed");
  });

  it("invalidates dormant provider cursors and matching receipts after a successful mutation", () => {
    const ownerForMutation = { groupId: "group-provider", threadId: "thread-provider", botId: "bot-provider" };
    const instanceId = "instance-provider";
    const input = { ...context(["provider"]), owner: ownerForMutation, selection: { instanceId, model: "model" } };
    const previous = process.env.OMB_ROOM_SESSION_CONTINUITY;
    try {
      process.env.OMB_ROOM_SESSION_CONTINUITY = "1";
      const first = planRoomTurn(input);
      expect(markDispatched(first)).toBe(true);
      recordSession(ownerForMutation, instanceId, "provider-session", first);
      settle(first, "settled");
      writeAcpInstructionReceipt(instanceId, ownerForMutation.botId, ownerForMutation.threadId, "provider-session", [
        { id: "memory", label: "Memory", text: "private", bytes: 7 },
      ]);
      const otherOwner = { groupId: "group-provider", threadId: "thread-other-provider", botId: "bot-provider" };
      const otherInstance = "instance-other-provider";
      const otherInput = { ...context(["other-provider"]), owner: otherOwner, selection: { instanceId: otherInstance, model: "model" } };
      const other = planRoomTurn(otherInput);
      expect(markDispatched(other)).toBe(true);
      recordSession(otherOwner, otherInstance, "other-session", other);
      settle(other, "settled");
      expect(usesInstance(instanceId)).toBe(false);
      invalidateInstance(instanceId);
      const stored = records().find((record: any) => record.threadId === ownerForMutation.threadId);
      expect(stored.cursors).toEqual({});
      expect(stored.deliveredThroughMessageId).toBeUndefined();
      expect(existsSync(acpInstructionReceiptPath(instanceId, ownerForMutation.botId, ownerForMutation.threadId, "provider-session"))).toBe(false);
      expect(records().find((record: any) => record.threadId === otherOwner.threadId)?.cursors).toEqual({ [otherInstance]: "other-session" });
      expect(planRoomTurn({ ...input, eligibleMessageIds: ["provider", "next"] }).resumeCursor).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.OMB_ROOM_SESSION_CONTINUITY;
      else process.env.OMB_ROOM_SESSION_CONTINUITY = previous;
    }
  });

  it("invalidates matching dormant state when continuity is rolled back off", () => {
    const ownerForRollback = { groupId: "group-rollback", threadId: "thread-rollback", botId: "bot-rollback" };
    const instanceId = "instance-rollback";
    const input = { ...context(["rollback"]), owner: ownerForRollback, selection: { instanceId, model: "model" } };
    const previous = process.env.OMB_ROOM_SESSION_CONTINUITY;
    try {
      process.env.OMB_ROOM_SESSION_CONTINUITY = "1";
      const first = planRoomTurn(input);
      markDispatched(first);
      recordSession(ownerForRollback, instanceId, "rollback-session", first);
      settle(first, "settled");
      process.env.OMB_ROOM_SESSION_CONTINUITY = "0";
      invalidateInstance(instanceId);
      const invalidated = records().find((record: any) => record.threadId === ownerForRollback.threadId);
      expect(invalidated?.cursors).toEqual({});
      expect(invalidated?.deliveredThroughMessageId).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.OMB_ROOM_SESSION_CONTINUITY;
      else process.env.OMB_ROOM_SESSION_CONTINUITY = previous;
    }
  });

  it("invalidates bot state when continuity is rolled back off", () => {
    const ownerForRollback = { groupId: "group-bot-rollback", threadId: "thread-bot-rollback", botId: "bot-bot-rollback" };
    const instanceId = "instance-bot-rollback";
    const input = { ...context(["bot-rollback"]), owner: ownerForRollback, selection: { instanceId, model: "model" } };
    const first = planRoomTurn(input);
    expect(markDispatched(first)).toBe(true);
    recordSession(ownerForRollback, instanceId, "bot-rollback-session", first);
    settle(first, "settled");
    const before = records().find((record: any) => record.threadId === ownerForRollback.threadId);
    process.env.OMB_ROOM_SESSION_CONTINUITY = "0";
    invalidateBot(ownerForRollback.botId);
    const after = records().find((record: any) => record.threadId === ownerForRollback.threadId);
    expect(after?.cursors).toEqual({});
    expect(after?.deliveredThroughMessageId).toBeUndefined();
    expect(after?.generation).toBeGreaterThan(before.generation);
  });

  it("does not let a stale session event recreate a deleted owner", () => {
    const deletedOwner = { groupId: "group-deleted-race", threadId: "thread-deleted-race", botId: "bot-deleted-race" };
    const first = planRoomTurn({ ...context(["deleted"]), owner: deletedOwner });
    markDispatched(first);
    deleteThread(deletedOwner.groupId, deletedOwner.threadId);
    recordSession(deletedOwner, selection.instanceId, "stale-session", first);
    settle(first, "settled");
    expect(records().some((record: any) => record.threadId === deletedOwner.threadId)).toBe(false);
  });

  it("persists private state with restrictive permissions and deletion removes owners", () => {
    const privateFile = join(process.env.HOME!, ".openmausbot", "room-continuations.json");
    expect(statSync(privateFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(privateFile, "utf8"))).toHaveProperty("version", 1);
    deleteThread(owner.groupId, owner.threadId);
    deleteBot("bot-c");
    expect(records().some((record: any) => record.groupId === owner.groupId)).toBe(false);
  });

  it("removes ACP receipts when an owner is invalidated", () => {
    const receiptOwner = { groupId: "group-receipt", threadId: "thread-receipt", botId: "bot-receipt" };
    const first = planRoomTurn({ ...context(["receipt"]), owner: receiptOwner });
    expect(markDispatched(first)).toBe(true);
    recordSession(receiptOwner, selection.instanceId, "receipt-session", first);
    writeAcpInstructionReceipt(selection.instanceId, receiptOwner.botId, receiptOwner.threadId, "receipt-session", [
      { id: "memory", label: "Memory", text: "private", bytes: 7 },
    ]);
    expect(existsSync(acpInstructionReceiptPath(selection.instanceId, receiptOwner.botId, receiptOwner.threadId, "receipt-session"))).toBe(true);
    invalidateBot(receiptOwner.botId);
    expect(existsSync(acpInstructionReceiptPath(selection.instanceId, receiptOwner.botId, receiptOwner.threadId, "receipt-session"))).toBe(false);
  });

  it("counts only enabled in-flight room work for provider settings guards", () => {
    const ownerForGuard = { groupId: "group-guard", threadId: "thread-guard", botId: "bot-guard" };
    const instanceId = "instance-guard";
    const input = { ...context(["guard"]), owner: ownerForGuard, selection: { instanceId, model: "model" } };
    const previous = process.env.OMB_ROOM_SESSION_CONTINUITY;
    try {
      process.env.OMB_ROOM_SESSION_CONTINUITY = "1";
      const plan = planRoomTurn(input);
      expect(usesInstance(instanceId)).toBe(false);
      expect(markDispatched(plan)).toBe(true);
      expect(usesInstance(instanceId)).toBe(true);
      recordSession(ownerForGuard, instanceId, "guard-session", plan);
      settle(plan, "settled");
      expect(usesInstance(instanceId)).toBe(false);
      process.env.OMB_ROOM_SESSION_CONTINUITY = "0";
      const resumed = planRoomTurn({ ...input, eligibleMessageIds: ["guard", "guard-next"] });
      expect(markDispatched(resumed)).toBe(true);
      expect(usesInstance(instanceId)).toBe(false);
      settle(resumed, "provider_failed");
    } finally {
      if (previous === undefined) delete process.env.OMB_ROOM_SESSION_CONTINUITY;
      else process.env.OMB_ROOM_SESSION_CONTINUITY = previous;
    }
  });
});
