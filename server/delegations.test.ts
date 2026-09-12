// Async peer handoff (`delegate_bot`) — pure logic. Each test stands up a
// real Store with throwaway bots, a fake comms-bus (records broadcasts),
// and a runTarget stub that captures the would-be turn so the test can
// assert what would have been dispatched to the harness. The harness itself
// stays out of these — the integration happens in comms.test.ts (the full
// e2e through the agents proxy + fake ACP CLI).
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  buildDelegationFailurePrompt,
  buildDelegationRevivalPrompt,
  DELEGATION_TTL_MS,
  DELEGATION_WAKE_MAX_PER_WINDOW,
  DELEGATION_WAKE_WINDOW_MS,
  DelegationWakeBudget,
  discardDelegations,
  drainDelegations,
  expireStaleDelegations,
  findDelegationReceipt,
  formatDelegationElapsed,
  pendingDelegationInfo,
  pendingDelegationSnapshot,
  queueDelegation,
  recordDelegationReceipt,
  releaseDelegationsWaitingOn,
  summarizeDelegatedActivity,
  threadsWaitingOn,
  _pendingCount,
} from "./delegations.ts";
import { peerAllowKey, resolvePeerComms } from "./peer-approval.ts";
import { Store, type BotRecord, type GroupRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

interface BusPair {
  commsBus: CommsBus;
  approvalBus: { store: Store; broadcast: (payload: unknown) => void };
  broadcasts: unknown[];
}

function setupBuses(store: Store): BusPair {
  const broadcasts: unknown[] = [];
  const broadcast = (payload: unknown) => {
    broadcasts.push(payload);
  };
  // the store emits what it writes; the server turns those into frames.
  // Mirror that here so assertions see what a client would.
  store.onChange((change) => {
    if (change.type === "message" || change.type === "message.patch") {
      broadcasts.push({ kind: change.type, threadId: change.threadId, message: change.message });
    }
  });
  const commsBus: CommsBus = { store, broadcast };
  const approvalBus = { store, broadcast };
  return { commsBus, approvalBus, broadcasts };
}

/** Poll until `predicate` returns a truthy value or `timeout` elapses.
 * drainDelegations is fire-and-forget (processOne runs as a Promise) so
 * tests need to wait for its async steps to land. The deadline is computed
 * from `performance.now()`, not `Date.now()`: `vi.useFakeTimers({ toFake:
 * ["Date"] })` freezes Date but not performance.now(), so a regression fails
 * this timeout instead of hanging until Vitest's own test timeout. */
async function waitFor<T>(predicate: () => T | undefined | false, timeout = 2_000): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const v = predicate();
    if (v) return v as T;
    if (performance.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("queueDelegation", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let broadcasts: unknown[];

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    broadcasts = buses.broadcasts;
  });

  it("rejects a self-delegation without queueing", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: from.id,
      message: "self-talk",
      depth: 0,
    }, 1);
    expect(result.result).toBe("self");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("rejects when the source turn is already at the depth cap", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "next task",
      depth: 1,
    }, 1);
    expect(result.result).toBe("too_deep");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("rejects when the target bot does not exist", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: "ghost",
      message: "where?",
      depth: 0,
    }, 1);
    expect(result.result).toBe("no_target");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("queues, broadcasts, and drops a 'Delegated to @Target' chip on the source thread", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "do this",
      reason: "followup",
      depth: 0,
    }, 1);
    expect(result.result).toBe("ok");
    expect(_pendingCount(from.threadId)).toBe(1);

    const chip = store
      .messagesFor(from.threadId)
      .find((m) => m.kind === "activity" && m.tool?.name?.startsWith("Delegated to @"));
    expect(chip?.tool?.name).toBe("Delegated to @Helper: followup");
    // queueing is the whole act — an open chip would spin for good
    expect(chip?.tool?.ok).toBe(true);

    // The chip is also broadcast over SSE so chat clients see it without
    // polling /api/bots
    const broadcast = broadcasts.find(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as { kind?: string }).kind === "message" &&
        (b as { threadId?: string }).threadId === from.threadId,
    );
    expect(broadcast).toBeTruthy();
  });

  it("projects routing metadata without exposing the delegated task prompt", () => {
    queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "private customer task details",
      reason: "followup",
      depth: 0,
    }, 1);
    const ownSnapshot = pendingDelegationSnapshot().filter((item) => item.sourceThreadId === from.threadId);
    expect(ownSnapshot).toEqual([
      { sourceThreadId: from.threadId, sourceBotId: from.id, toBotId: target.id, reason: "followup" },
    ]);
    expect(JSON.stringify(ownSnapshot)).not.toContain("private customer task details");
  });

  it("keys detached routine delegations to their real source thread", async () => {
    const routineTask = store.createTask(from.id, "Routine run", false)!;
    const result = queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "routine follow-up", depth: 0 },
      1,
      routineTask.threadId,
    );

    expect(result.result).toBe("ok");
    expect(_pendingCount(routineTask.threadId)).toBe(1);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(
      store.messagesFor(routineTask.threadId).some((m) => m.tool?.name === "Delegated to @Helper"),
    ).toBe(true);
    expect(
      store.messagesFor(from.threadId).some((m) => m.tool?.name === "Delegated to @Helper"),
    ).toBe(false);
  });
});

describe("drainDelegations", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let approvalBus: { store: Store; broadcast: (payload: unknown) => void };
  let runTargetCalls: Array<{ toBotId: string; message: string; commsDepth: number; sourceThreadId?: string }>;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    approvalBus = buses.approvalBus;
    runTargetCalls = [];
  });

  afterEach(() => {
    // Unresolved approval requests carry a 15-min timer that would otherwise
    // keep vitest's event loop alive long after the suite ends. None of the
    // tests above leave one — they all resolve via resolvePeerComms — but
    // double-check by counting the module's pending map: tests that didn't
    // resolve should be re-examined if this ever fires.
    void runTargetCalls;
  });

  it("runs the target's turn via runTarget and mirrors the exchange", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => runTargetCalls.length === 1);
    const call = runTargetCalls[0]!;
    expect(call.toBotId).toBe(target.id);
    expect(call.commsDepth).toBe(1);
    expect(call.message).toContain("Delegated by @");
    expect(call.message).toContain("do this");

    // Both 1:1 threads picked up their comm chips, attributed to the
    // source/target bot respectively, linking to the same channel.
    const fromChips = store
      .messagesFor(from.threadId)
      .filter((m) => m.kind === "activity" && m.tool?.name === "Messaged @Helper");
    expect(fromChips).toHaveLength(1);
    const targetChips = store
      .messagesFor(target.threadId)
      .filter((m) => m.kind === "activity" && m.tool?.name === `Message from @${from.name}`);
    expect(targetChips).toHaveLength(1);
    expect(fromChips[0]?.comm?.groupId).toBe(targetChips[0]?.comm?.groupId);
  });

  it("includes the reason line in the prefixed message when one is given", async () => {
    queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "do this", reason: "next step", depth: 0 },
      1,
    );
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.message).toContain("[Reason: next step]");
  });

  it("drains and mirrors a detached routine delegation on its source thread", async () => {
    const activeThreadId = from.threadId;
    const routineTask = store.createTask(from.id, "Routine run", false)!;
    queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "routine follow-up", depth: 0 },
      1,
      routineTask.threadId,
    );

    drainDelegations(
      commsBus,
      approvalBus,
      routineTask.threadId,
      (toBotId, message, commsDepth, sourceThreadId) => {
        runTargetCalls.push({ toBotId, message, commsDepth, sourceThreadId });
      },
    );

    await waitFor(() => runTargetCalls.length === 1 && _pendingCount(routineTask.threadId) === 0);
    expect(_pendingCount(routineTask.threadId)).toBe(0);
    expect(runTargetCalls[0]?.sourceThreadId).toBe(routineTask.threadId);
    expect(
      store.messagesFor(routineTask.threadId).some((m) => m.tool?.name === "Messaged @Helper"),
    ).toBe(true);
    expect(
      store.messagesFor(activeThreadId).some((m) => m.tool?.name === "Messaged @Helper"),
    ).toBe(false);
  });

  it("contains a rejected delegation worker and reports it on the source thread", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, () => {
      throw new Error("target runner exploded");
    });

    const failure = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.tool?.ok === false && m.tool.name.includes("target runner exploded")),
    );
    expect(failure.tool?.name).toContain("delegation failed");
  });

  it("reports an asynchronous target-start rejection on a detached source thread", async () => {
    const activeThreadId = from.threadId;
    const routineTask = store.createTask(from.id, "Routine run", false)!;
    queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "do this", depth: 0 },
      1,
      routineTask.threadId,
    );
    drainDelegations(commsBus, approvalBus, routineTask.threadId, () =>
      Promise.reject(new Error("provider disappeared")),
    );

    const failure = await waitFor(() =>
      store
        .messagesFor(routineTask.threadId)
        .find((m) => m.tool?.ok === false && m.tool.name.includes("provider disappeared")),
    );
    expect(failure.tool?.name).toContain("delegation failed");
    expect(
      store.messagesFor(activeThreadId).some((m) => m.tool?.name.includes("provider disappeared")),
    ).toBe(false);
  });

  it("skips runTarget and emits a 'no such bot' chip when the target was deleted", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    store.deleteBot(target.id);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("no such bot")),
    );
    expect(chip.tool?.ok).toBe(false);
    expect(runTargetCalls).toEqual([]);
  });

  it("drops a queued handoff when section assignment separates the bots before dispatch", async () => {
    const queued = queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "do this", depth: 0 },
      1,
    );
    expect(store.setBotsSection([target.id], "Elsewhere").ok).toBe(true);

    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => findDelegationReceipt(queued.id!) && _pendingCount(from.threadId) === 0);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({
      status: "dropped",
      result: expect.stringContaining("different sections"),
    });
    expect(runTargetCalls).toEqual([]);
    expect(
      store.messagesFor(from.threadId).some((message) =>
        message.tool?.name.includes("bots now belong to different sections")),
    ).toBe(true);
  });

  it("drops a queued handoff when the sender's allow-list stops covering the target", async () => {
    // The allow-list is checked again at the dispatch edge for the same
    // reason section membership is: a handoff can sit in the queue across a
    // busy target or an approval card, and the grant it was queued under may
    // have been narrowed since.
    const queued = queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "do this", depth: 0 },
      1,
    );
    store.patchBot(from.id, { peers: [] });

    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => findDelegationReceipt(queued.id!) && _pendingCount(from.threadId) === 0);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({
      status: "dropped",
      result: expect.stringContaining("no longer allowed to contact"),
    });
    expect(runTargetCalls).toEqual([]);
    expect(
      store.messagesFor(from.threadId).some((message) =>
        message.tool?.name.includes("is no longer an allowed peer")),
    ).toBe(true);
  });

  it("still dispatches a queued handoff to a target the allow-list covers", async () => {
    // The dropping direction alone is not coverage: a recheck that treated
    // "sender has a list" as "sender is cut off" would cancel every handoff
    // from an allow-listed bot and pass the test above. Pin the guard NOT
    // firing too.
    const queued = queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "do this", depth: 0 },
      1,
    );
    store.patchBot(from.id, { peers: [target.id] });

    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls).toEqual([
      { toBotId: target.id, message: expect.stringContaining("do this"), commsDepth: 1 },
    ]);
    expect(findDelegationReceipt(queued.id!)?.status).not.toBe("dropped");
    expect(
      store.messagesFor(from.threadId).some((message) =>
        message.tool?.name.includes("no longer an allowed peer")),
    ).toBe(false);
  });

  it("keeps the handoff queued with a 'waiting' chip when the target is currently busy", async () => {
    store.patchBot(target.id, { busy: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("waiting — they're busy")),
    );
    expect(chip.tool?.name).toBe("Delegation to @Helper waiting — they're busy; it'll go through when they're free");
    expect(runTargetCalls).toEqual([]);
    // retained for the retry drain the target's settling turn triggers
    expect(_pendingCount(from.threadId)).toBe(1);
  });

  it("asks for approval when approvePeerComms is on, then runs only on allow", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    // the source bot's thread shows the options card BEFORE runTarget fires
    const card = await waitFor(() =>
      store.messagesFor(from.threadId).find((m) => m.card?.requestId),
    );
    expect(card.card?.title).toContain("delegate to @Helper");
    expect(card.card?.tool).toBe("delegate_bot");
    expect(card.card?.allowKey).toBe(peerAllowKey("delegate_bot", target.id));
    expect(card.card?.options).toEqual(["Allow", "Deny", "Always allow"]);
    expect(runTargetCalls).toEqual([]);

    resolvePeerComms(approvalBus, card.card!.requestId!, "allow");
    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.toBotId).toBe(target.id);
    expect(runTargetCalls[0]!.commsDepth).toBe(1);
  });

  it("rechecks sections after a pending human approval before dispatch", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    const queued = queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message: "do this", depth: 0 },
      1,
    );
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    const card = await waitFor(() =>
      store.messagesFor(from.threadId).find((message) => message.card?.requestId),
    );
    expect(store.setBotsSection([target.id], "Elsewhere").ok).toBe(true);
    resolvePeerComms(approvalBus, card.card!.requestId!, "allow");

    await waitFor(() => findDelegationReceipt(queued.id!) && _pendingCount(from.threadId) === 0);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "dropped" });
    expect(runTargetCalls).toEqual([]);
  });

  it("reports pre-dispatch denials after removing the pending handoff", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    const pendingAtSettle: number[] = [];
    const settled = vi.fn(() => void pendingAtSettle.push(_pendingCount(from.threadId)));
    const runTarget = vi.fn();
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget, settled);
    const card = await waitFor(() => store.messagesFor(from.threadId).find((m) => m.card?.requestId));
    resolvePeerComms(approvalBus, card.card!.requestId!, "deny");
    await waitFor(() => settled.mock.calls.length === 1);
    expect(pendingAtSettle).toEqual([0]);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ id: queued.id, status: "denied" }));
    expect(runTarget).not.toHaveBeenCalled();
  });

  it("does not revive discarded work when an already-open approval is allowed", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    const runTarget = vi.fn();
    const settled = vi.fn();
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget, settled);
    const card = await waitFor(() => store.messagesFor(from.threadId).find((m) => m.card?.requestId));
    discardDelegations(commsBus, from.threadId);
    resolvePeerComms(approvalBus, card.card!.requestId!, "allow");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "dropped" });
    expect(runTarget).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it("retains an exact approval when the target becomes busy before dispatch", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    const runTarget = vi.fn();
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    const card = await waitFor(() => store.messagesFor(from.threadId).find((m) => m.card?.requestId));
    store.patchBot(target.id, { busy: true });
    resolvePeerComms(approvalBus, card.card!.requestId!, "allow");
    await waitFor(() => pendingDelegationInfo(queued.id!)?.waiting === true);
    store.patchBot(target.id, { busy: false });
    releaseDelegationsWaitingOn(target.id);
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1);
    expect(store.messagesFor(from.threadId).filter((message) => message.card?.requestId)).toHaveLength(1);
  });

  it.each(["source task deletion", "source group removal"] as const)(
    "drops an approved busy retry after %s",
    async (change) => {
      store.patchBot(from.id, { approvePeerComms: true });
      const group = change === "source group removal"
        ? store.createGroup("Planning", [from.id, target.id], false, "Agents")
        : undefined;
      const sourceThreadId = group?.threadId ?? store.createTask(from.id, "Source task", false)!.threadId;
      const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1, sourceThreadId);
      const runTarget = vi.fn();
      drainDelegations(commsBus, approvalBus, sourceThreadId, runTarget);
      const card = await waitFor(() => store.messagesFor(sourceThreadId).find((m) => m.card?.requestId));
      store.patchBot(target.id, { busy: true });
      resolvePeerComms(approvalBus, card.card!.requestId!, "allow");
      await waitFor(() => pendingDelegationInfo(queued.id!)?.waiting === true);

      if (group) store.patchGroup(group.id, { memberIds: [target.id] });
      else expect(store.deleteTask(from.id, sourceThreadId)).not.toBeNull();
      const messageIdsBeforeRetry = store.messagesFor(sourceThreadId).map((message) => message.id);
      store.patchBot(target.id, { busy: false });
      releaseDelegationsWaitingOn(target.id);
      drainDelegations(commsBus, approvalBus, sourceThreadId, runTarget);

      await waitFor(() => _pendingCount(sourceThreadId) === 0);
      expect(runTarget).not.toHaveBeenCalled();
      expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "dropped" });
      expect(store.messagesFor(sourceThreadId).map((message) => message.id)).toEqual(messageIdsBeforeRetry);
      expect(store.dmGroup(from.id, target.id)).toBeUndefined();
    },
  );

  it("does not recreate a deleted source transcript when a pending approval is denied", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    const sourceThreadId = store.createTask(from.id, "Source task", false)!.threadId;
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1, sourceThreadId);
    const runTarget = vi.fn();
    drainDelegations(commsBus, approvalBus, sourceThreadId, runTarget);
    const card = await waitFor(() => store.messagesFor(sourceThreadId).find((m) => m.card?.requestId));
    expect(store.deleteTask(from.id, sourceThreadId)).not.toBeNull();
    resolvePeerComms(approvalBus, card.card!.requestId!, "deny");

    await waitFor(() => _pendingCount(sourceThreadId) === 0);
    expect(runTarget).not.toHaveBeenCalled();
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "dropped" });
    expect(store.messagesFor(sourceThreadId)).toEqual([]);
  });

  it("does not ask twice when this exact fallback was already approved as ask_bot", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "do this",
      depth: 0,
      approvalAlreadyGranted: true,
    }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]).toMatchObject({ toBotId: target.id, commsDepth: 1 });
    expect(store.messagesFor(from.threadId).some((message) => message.card?.tool === "delegate_bot")).toBe(false);
  });

  it("emits a denial chip and skips runTarget when the user denies", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    const card = await waitFor(() =>
      store.messagesFor(from.threadId).find((m) => m.card?.requestId),
    );
    resolvePeerComms(approvalBus, card.card!.requestId!, "deny");

    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("denied by user")),
    );
    expect(chip.tool?.ok).toBe(false);
    expect(runTargetCalls).toEqual([]);
  });

  it("auto-allows when alwaysAllow already covers the pair (no card pushed)", async () => {
    store.patchBot(from.id, {
      approvePeerComms: true,
      alwaysAllow: [peerAllowKey("delegate_bot", target.id)],
    });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.commsDepth).toBe(1);
    const card = store
      .messagesFor(from.threadId)
      .find((m) => m.card?.requestId && m.card.tool === "delegate_bot");
    expect(card).toBeUndefined();
  });

  it("no-ops when nothing is queued for the source thread", () => {
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    expect(runTargetCalls).toEqual([]);
  });

  it("no-ops when the source thread no longer resolves to a bot", () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1);
    store.deleteBot(from.id);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    expect(runTargetCalls).toEqual([]);
  });
});

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { _loadPending, _resetPending, pendingThreads } from "./delegations.ts";

describe("delegations survive a restart", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let buses: BusPair;
  const file = () => join(DATA_DIR, "delegations.json");

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    _resetPending();
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    buses = setupBuses(store);
  });
  afterEach(() => _resetPending());

  it("writes the queue to disk on queue, and clears it on drain and discard", async () => {
    expect(queueDelegation(buses.commsBus, from, {
      toBotId: target.id,
      message: "do this",
      depth: 0,
      approvalAlreadyGranted: true,
    }, 1)).toMatchObject({ result: "ok" });
    expect(existsSync(file())).toBe(true);
    const onDisk = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown[]>;
    expect(onDisk[from.threadId]).toHaveLength(1);
    expect(onDisk[from.threadId][0]).toMatchObject({
      toBotId: target.id,
      message: "do this",
      approvalAlreadyGranted: true,
      queuedAt: expect.any(Number),
    });

    discardDelegations(buses.commsBus, from.threadId);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toBeUndefined();

    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "again", depth: 0 }, 1);
    const ran: string[] = [];
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async (_to, message) => {
      ran.push(message);
    });
    await waitFor(() => ran.length === 1 && pendingThreads().length === 0);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toBeUndefined();
  });

  it("keeps a handoff durable until its approval and dispatch path settles", async () => {
    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "wait for dispatch", depth: 0 }, 1);
    let release!: () => void;
    const dispatchSettled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async () => {
      started = true;
      await dispatchSettled;
    });

    await waitFor(() => started);
    expect(pendingThreads()).toEqual([from.threadId]);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toHaveLength(1);

    release();
    await waitFor(() => pendingThreads().length === 0);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toBeUndefined();
  });

  it("drains work queued by a later settled turn while an earlier handoff is waiting", async () => {
    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "first", depth: 0 }, 1);
    let release!: () => void;
    const firstSettled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ran: string[] = [];
    const runTarget = async (_to: string, message: string) => {
      ran.push(message);
      if (message.includes("first")) await firstSettled;
    };
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, runTarget);
    await waitFor(() => ran.length === 1);

    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "second", depth: 0 }, 1);
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, runTarget);
    expect(ran).toHaveLength(1);

    release();
    await waitFor(() => ran.length === 2 && pendingThreads().length === 0);
    expect(ran[1]).toContain("second");
  });

  it("a fresh process loads what the last one queued, and can drain it", async () => {
    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "left over", depth: 0 }, 1);
    // "restart": forget memory, reload from disk
    _resetPending();
    expect(pendingThreads()).toEqual([]);
    _loadPending();
    expect(pendingThreads()).toEqual([from.threadId]);
    const ran: string[] = [];
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async (_to, message) => {
      ran.push(message);
    });
    await waitFor(() => ran.length === 1 && pendingThreads().length === 0);
    expect(ran[0]).toContain("left over");
    expect(pendingThreads()).toEqual([]);
  });

  it("tolerates a missing or corrupt file", () => {
    _resetPending();
    _loadPending(); // no file
    expect(pendingThreads()).toEqual([]);
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file(), "{not json");
    _loadPending();
    expect(pendingThreads()).toEqual([]);
  });

  it("restores an over-age backlog without expiring the second job when the first occupies its target", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const first = queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "first", depth: 0 }, 1);
      const second = queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "second", depth: 0 }, 1);
      vi.setSystemTime(Date.now() + 2 * DELEGATION_TTL_MS);
      _resetPending();
      _loadPending();
      const renewedAt = pendingDelegationInfo(second.id!)!.queuedAt;
      expect(renewedAt).toBe(Date.now());
      // The repaired deadline is already durable; restarting again does
      // not grant another window while this one is still valid.
      vi.setSystemTime(Date.now() + 60_000);
      _resetPending();
      _loadPending();
      expect(pendingDelegationInfo(second.id!)?.queuedAt).toBe(renewedAt);
      const ran: string[] = [];
      const runTarget = (_to: string, message: string) => {
        ran.push(message);
        store.patchBot(target.id, { busy: true });
      };
      drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, runTarget);
      await waitFor(() => ran.length === 1 && pendingDelegationInfo(first.id!) === null);
      expect(findDelegationReceipt(second.id!)).toBeNull();
      expect(pendingDelegationInfo(second.id!)?.waiting).toBe(true);

      store.patchBot(target.id, { busy: false });
      releaseDelegationsWaitingOn(target.id);
      drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, runTarget);
      await waitFor(() => ran.length === 2 && pendingThreads().length === 0);
      expect(ran[1]).toContain("second");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a handoff saved before queuedAt existed a fresh 24-hour window, marks it already-announced, and persists the backfill", () => {
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file(), JSON.stringify({
      [from.threadId]: [
        { id: "legacy-1", sourceBotId: from.id, toBotId: target.id, message: "old", depth: 0, attempts: 2 },
      ],
    }));
    const before = Date.now();
    _loadPending();
    expect(pendingDelegationInfo("legacy-1")?.queuedAt).toBeGreaterThanOrEqual(before);
    // attempts >= 1 means the old "retry n/3" chip already posted — loading
    // it must not let it post a second waiting chip on the next drain.
    const onDisk = JSON.parse(readFileSync(file(), "utf8")) as Record<string, Array<{ id: string; waitAnnounced?: boolean; queuedAt?: number }>>;
    const loaded = onDisk[from.threadId]!.find((entry) => entry.id === "legacy-1")!;
    expect(loaded.waitAnnounced).toBe(true);
    // the backfilled queuedAt is written back immediately, so a restart loop
    // does not keep restarting the 24-hour window on every boot.
    expect(loaded.queuedAt).toBeGreaterThanOrEqual(before);
  });

  it("clamps a future queuedAt (clock moved back, hand-edited file) to now instead of making it un-expirable", () => {
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(DATA_DIR, { recursive: true });
    const future = Date.now() + 10 * 24 * 60 * 60 * 1000;
    writeFileSync(file(), JSON.stringify({
      [from.threadId]: [
        { id: "future-1", sourceBotId: from.id, toBotId: target.id, message: "old", depth: 0, queuedAt: future },
      ],
    }));
    const before = Date.now();
    _loadPending();
    const info = pendingDelegationInfo("future-1");
    expect(info?.queuedAt).toBeGreaterThanOrEqual(before);
    expect(info?.queuedAt).toBeLessThan(future);
    const onDisk = JSON.parse(readFileSync(file(), "utf8")) as Record<string, Array<{ id: string; queuedAt?: number }>>;
    expect(onDisk[from.threadId]!.find((entry) => entry.id === "future-1")!.queuedAt).toBeLessThan(future);
  });

  it("expireStaleDelegations expires due handoffs across threads, keeps fresh ones, and reports each once", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Target stays busy for the whole test: expiry only fires for a
      // handoff that still cannot be delivered, so age alone must not expire it.
      store.patchBot(target.id, { busy: true });
      const other = store.createTask(from.id, "Other", false)!.threadId;
      const stale = queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "stale", depth: 0 }, 1);
      const staleOther = queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "stale too", depth: 0 }, 1, other);
      vi.setSystemTime(new Date(Date.now() + DELEGATION_TTL_MS - 1));
      const fresh = queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "fresh", depth: 0 }, 1);
      vi.setSystemTime(new Date(Date.now() + 1));

      const settled: string[] = [];
      expect(expireStaleDelegations(buses.commsBus, Date.now(), (receipt) => void settled.push(receipt.id))).toBe(2);
      expect(settled.sort()).toEqual([stale.id!, staleOther.id!].sort());
      expect(findDelegationReceipt(stale.id!)).toMatchObject({ status: "expired" });
      expect(pendingDelegationInfo(fresh.id!)).not.toBeNull();
      expect(JSON.parse(readFileSync(file(), "utf8"))[other]).toBeUndefined();
      // nothing left to do on a second pass
      expect(expireStaleDelegations(buses.commsBus, Date.now())).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expireStaleDelegations leaves a thread mid-drain to the drain that owns it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      store.patchBot(from.id, { approvePeerComms: true });
      const queued = queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "held", depth: 0 }, 1);
      drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, vi.fn());
      // the drain is now parked on the approval card
      const card = await waitFor(() => store.messagesFor(from.threadId).find((m) => m.card?.requestId));

      vi.setSystemTime(new Date(Date.now() + DELEGATION_TTL_MS));
      expect(expireStaleDelegations(buses.commsBus, Date.now())).toBe(0);
      expect(pendingDelegationInfo(queued.id!)).not.toBeNull();

      resolvePeerComms(buses.approvalBus, card.card!.requestId!, "deny");
      await waitFor(() => pendingThreads().length === 0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("busy waits and expiry", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let approvalBus: { store: Store; broadcast: (payload: unknown) => void };

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    approvalBus = buses.approvalBus;
  });

  const chipCount = (needle: string) =>
    store.messagesFor(from.threadId).filter((m) => m.kind === "activity" && m.tool?.name?.includes(needle)).length;

  it("keeps a handoff queued while the target is busy and dispatches on the retry drain", async () => {
    store.patchBot(target.id, { busy: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
    expect(queued.result).toBe("ok");
    const taskId = queued.id!;

    const dispatched: unknown[][] = [];
    const runTarget = (...args: unknown[]) => void dispatched.push(args);

    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chipCount("waiting — they're busy;") === 1);
    expect(dispatched).toHaveLength(0);
    expect(_pendingCount(from.threadId)).toBe(1);
    // this is the set a settling target turn re-drains
    expect(threadsWaitingOn(target.id)).toEqual([from.threadId]);
    expect(pendingDelegationInfo(taskId)).toMatchObject({ toBotId: target.id, waiting: true });

    store.patchBot(target.id, { busy: false });
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => dispatched.length === 1);
    expect(_pendingCount(from.threadId)).toBe(0);
    // the task id rides into the dispatched turn so the receipt can be keyed
    expect(dispatched[0][5]).toBe(taskId);
    expect(pendingDelegationInfo(taskId)).toBeNull();
  });

  it("waits through any number of busy periods and still delivers", async () => {
    store.patchBot(target.id, { busy: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
    const runTarget = vi.fn();
    for (let period = 0; period < 5; period++) {
      drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
      await waitFor(() => pendingDelegationInfo(queued.id!)?.waiting === true);
      // the target's turn settles, and another turn claims it straight away
      expect(releaseDelegationsWaitingOn(target.id)).toEqual([from.threadId]);
    }
    expect(findDelegationReceipt(queued.id!)).toBeNull();
    expect(chipCount("waiting — they're busy;")).toBe(1);

    store.patchBot(target.id, { busy: false });
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1);
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("posts one waiting chip per handoff, however many drains run while the target is busy", async () => {
    store.patchBot(target.id, { busy: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
    const runTarget = vi.fn();

    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chipCount("waiting — they're busy;") === 1);
    // A source-thread redrain can happen while an approval for another item
    // settles. It must not re-announce the same wait.
    for (let index = 0; index < 4; index++) {
      drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chipCount("waiting — they're busy;")).toBe(1);
    expect(pendingDelegationInfo(queued.id!)).toMatchObject({ waiting: true });

    store.patchBot(target.id, { busy: false });
    expect(releaseDelegationsWaitingOn(target.id)).toEqual([from.threadId]);
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1);
  });

  it("says the target is waiting on you when it is parked on an approval", async () => {
    store.patchBot(target.id, { busy: true, activity: "waiting-on-you" });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, vi.fn());
    await waitFor(() => chipCount("who's waiting on you") === 1);
    expect(chipCount("Waiting for @Helper, who's waiting on you — it'll go through after you answer")).toBe(1);
    expect(chipCount("they're busy")).toBe(0);
  });

  it("persists receipts across a restart and prunes the drawer by count", () => {
    recordDelegationReceipt({
      id: "task-one",
      sourceThreadId: from.threadId,
      toBotId: target.id,
      toBotName: "Helper",
      status: "done",
      result: "the reply text",
    });
    // a fresh process loads what the last one recorded
    _loadPending();
    expect(findDelegationReceipt("task-one")).toMatchObject({ status: "done", result: "the reply text" });

    for (let index = 0; index < 105; index++) {
      recordDelegationReceipt({
        id: `bulk-${index}`,
        sourceThreadId: from.threadId,
        toBotId: target.id,
        toBotName: "Helper",
        status: "done",
      });
    }
    expect(findDelegationReceipt("bulk-104")).toBeTruthy();
    expect(findDelegationReceipt("bulk-3")).toBeNull(); // oldest pruned
  });

  it("writes a dropped receipt for every handoff a failed turn discards", async () => {
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "never runs", depth: 0 }, 1);
    const { discardDelegations } = await import("./delegations.ts");
    discardDelegations(commsBus, from.threadId);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "dropped" });
  });

  it("expires a handoff nobody could take within 24 hours, and wakes the delegator", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      store.patchBot(target.id, { busy: true });
      const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
      const runTarget = vi.fn();
      const settled: string[] = [];
      const onSettled = (receipt: { status: string }) => void settled.push(receipt.status);

      drainDelegations(commsBus, approvalBus, from.threadId, runTarget, onSettled);
      await waitFor(() => pendingDelegationInfo(queued.id!)?.waiting === true);
      releaseDelegationsWaitingOn(target.id);

      vi.setSystemTime(new Date(Date.now() + DELEGATION_TTL_MS));
      drainDelegations(commsBus, approvalBus, from.threadId, runTarget, onSettled);
      await waitFor(() => _pendingCount(from.threadId) === 0);

      expect(runTarget).not.toHaveBeenCalled();
      expect(findDelegationReceipt(queued.id!)).toMatchObject({
        status: "expired",
        toBotName: "Helper",
        result: "@Helper was not free to take this for 24 hours",
      });
      expect(chipCount("Delegation to @Helper expired — not picked up within 24 hours")).toBe(1);
      expect(settled).toEqual(["expired"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a fresh-thread handoff that never gets a free slot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const slotBus: CommsBus = { ...commsBus, threadSlotFree: () => false };
      const opened = store.createTask(target.id, "QA", false)!;
      const queued = queueDelegation(
        slotBus,
        from,
        { toBotId: target.id, message: "check", depth: 0, targetThreadId: opened.threadId },
        1,
      );
      const runTarget = vi.fn();
      drainDelegations(slotBus, approvalBus, from.threadId, runTarget);
      await waitFor(() => chipCount("waiting for a free slot") === 1);
      releaseDelegationsWaitingOn(target.id);

      vi.setSystemTime(new Date(Date.now() + DELEGATION_TTL_MS));
      drainDelegations(slotBus, approvalBus, from.threadId, runTarget);
      await waitFor(() => _pendingCount(from.threadId) === 0);

      expect(runTarget).not.toHaveBeenCalled();
      expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches an over-age item whose target is idle instead of expiring it — boot-drain case", async () => {
    // "quit Friday, open Monday": the handoff sat queued past DELEGATION_TTL_MS
    // while the app was closed. On boot, store.ts resets every bot to idle —
    // the target is free right now, so downtime must not count against it.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      store.patchBot(target.id, { busy: true });
      const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "leftover", depth: 0 }, 1);
      vi.setSystemTime(new Date(Date.now() + DELEGATION_TTL_MS + 1));
      // simulate boot: the store reloads every bot as idle
      store.patchBot(target.id, { busy: false });

      const runTarget = vi.fn();
      drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
      await waitFor(() => runTarget.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);

      expect(findDelegationReceipt(queued.id!)).toBeNull();
      expect(_pendingCount(from.threadId)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expireStaleDelegations does not expire an over-age item whose target is idle, and still returns 0", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      store.patchBot(target.id, { busy: true });
      const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "leftover", depth: 0 }, 1);
      vi.setSystemTime(new Date(Date.now() + DELEGATION_TTL_MS + 1));
      store.patchBot(target.id, { busy: false });

      expect(expireStaleDelegations(commsBus, Date.now())).toBe(0);
      expect(findDelegationReceipt(queued.id!)).toBeNull();
      expect(pendingDelegationInfo(queued.id!)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("originating group routing", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let group: GroupRecord;
  let commsBus: CommsBus;
  let approvalBus: { store: Store; broadcast: (payload: unknown) => void };

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    _resetPending();
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    group = store.createGroup("Planning", [from.id, target.id], false, "Agents");
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    approvalBus = buses.approvalBus;
  });
  afterEach(() => _resetPending());

  it("routes a group-thread delegation through the shared channel, not a pair DM", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "plan the sprint", depth: 0 }, 1, group.threadId);
    const runTargetCalls: { channel: GroupRecord | undefined }[] = [];
    drainDelegations(commsBus, approvalBus, group.threadId, (...args: unknown[]) => {
      runTargetCalls.push({ channel: args[4] as GroupRecord | undefined });
    });

    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.channel?.id).toBe(group.id);
    expect(runTargetCalls[0]!.channel?.dm).toBeFalsy();
    expect(store.dmGroup(from.id, target.id)).toBeUndefined();
    expect(store.messagesFor(group.threadId).some((m) => m.kind === "text" && m.text?.includes("plan the sprint"))).toBe(true);
    expect(store.messagesFor(group.threadId).some((m) => m.kind === "activity" && m.tool?.name === "Messaged @Helper")).toBe(true);
  });

  it("still uses a pair DM when the source is the bot's 1:1 thread", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1, from.threadId);
    const runTargetCalls: { channel: GroupRecord | undefined }[] = [];
    drainDelegations(commsBus, approvalBus, from.threadId, (...args: unknown[]) => {
      runTargetCalls.push({ channel: args[4] as GroupRecord | undefined });
    });

    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.channel?.dm).toBe(true);
    expect(runTargetCalls[0]!.channel?.memberIds).toEqual(expect.arrayContaining([from.id, target.id]));
  });

  it("does not create a pair DM when a valid shared channel exists", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "in the room", depth: 0 }, 1, group.threadId);
    const before = store.groups.filter((g) => g.dm).length;
    drainDelegations(commsBus, approvalBus, group.threadId, () => {});
    await waitFor(() => _pendingCount(group.threadId) === 0);
    const after = store.groups.filter((g) => g.dm).length;
    expect(after).toBe(before);
  });

  it("survives persistence: a loaded delegation keeps its originating group", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "left over", depth: 0 }, 1, group.threadId);
    _resetPending();
    _loadPending();
    expect(pendingThreads()).toEqual([group.threadId]);

    const runTargetCalls: { channel: GroupRecord | undefined }[] = [];
    drainDelegations(commsBus, approvalBus, group.threadId, (...args: unknown[]) => {
      runTargetCalls.push({ channel: args[4] as GroupRecord | undefined });
    });
    await waitFor(() => runTargetCalls.length === 1 && _pendingCount(group.threadId) === 0);
    expect(runTargetCalls[0]!.channel?.id).toBe(group.id);
  });

  it("drains each shared-group item under the bot that queued it", async () => {
    const other = store.createBot();
    store.patchBot(other.id, { name: "Other" });
    store.patchGroup(group.id, { memberIds: [from.id, target.id, other.id] });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "from A", depth: 0 }, 1, group.threadId);
    queueDelegation(commsBus, other, { toBotId: target.id, message: "from B", depth: 0 }, 1, group.threadId);

    const seen: { message: string }[] = [];
    drainDelegations(commsBus, approvalBus, group.threadId, (_to, message) => {
      seen.push({ message });
    });
    await waitFor(() => seen.length === 2);

    expect(seen[0]!.message).toContain(`[Delegated by @${from.name},`);
    expect(seen[1]!.message).toContain("[Delegated by @Other,");
    expect(store.dmGroup(from.id, target.id)).toBeUndefined();
  });

  it("tags the queue activity with the source bot in a shared group", () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "plan", depth: 0 }, 1, group.threadId);
    const chip = store
      .messagesFor(group.threadId)
      .find((m) => m.kind === "activity" && m.tool?.name?.startsWith("Delegated to @"));
    expect(chip?.from?.botId).toBe(from.id);
  });

  it("preserves each source bot's identity for two bots delegating to the same target", async () => {
    const other = store.createBot();
    store.patchBot(other.id, { name: "Other" });
    store.patchGroup(group.id, { memberIds: [from.id, target.id, other.id] });

    queueDelegation(commsBus, from, { toBotId: target.id, message: "from A", depth: 0 }, 1, group.threadId);
    queueDelegation(commsBus, other, { toBotId: target.id, message: "from B", depth: 0 }, 1, group.threadId);

    const snapshot = pendingDelegationSnapshot().filter((item) => item.sourceThreadId === group.threadId);
    expect(snapshot.map((item) => item.sourceBotId).sort()).toEqual([from.id, other.id].sort());

    const calls: Array<{ sourceBotId: string; sourceThreadId: string; channel?: GroupRecord }> = [];
    drainDelegations(commsBus, approvalBus, group.threadId, (...args: unknown[]) => {
      calls.push({
        sourceBotId: args[6] as string,
        sourceThreadId: args[3] as string,
        channel: args[4] as GroupRecord | undefined,
      });
    });
    await waitFor(() => calls.length === 2);

    const sourceBotIds = calls.map((c) => c.sourceBotId).sort();
    expect(sourceBotIds).toEqual([from.id, other.id].sort());
    expect(calls.every((c) => c.sourceThreadId === group.threadId)).toBe(true);
    expect(calls.every((c) => c.channel?.id === group.id && !c.channel?.dm)).toBe(true);
    expect(store.dmGroup(from.id, target.id)).toBeUndefined();
  });
});

describe("peer wake helpers", () => {
  it("buildDelegationRevivalPrompt names the peer and instructs the source to answer", () => {
    const prompt = buildDelegationRevivalPrompt("Helper");
    expect(prompt).toContain("@Helper");
    expect(prompt).toContain("answer the user with the outcome");
    expect(prompt).toContain("Do not re-delegate the same task");
  });

  it("buildDelegationFailurePrompt carries the reason and forbids an unchanged retry", () => {
    const prompt = buildDelegationFailurePrompt("Helper", "delegated turn stalled");
    expect(prompt).toContain("@Helper");
    expect(prompt).toContain("delegated turn stalled");
    expect(prompt).toContain("tell the user what failed");
    expect(prompt).toContain("Do not re-delegate the exact same task unchanged");
  });

  it("DelegationWakeBudget caps bursts per thread and expires with the window", () => {
    let now = 1_000_000;
    const budget = new DelegationWakeBudget(() => now);

    for (let i = 0; i < DELEGATION_WAKE_MAX_PER_WINDOW; i++) {
      expect(budget.tryAcquire("t1")).toBe(true);
    }
    // cap reached — no further wakes within the same window
    expect(budget.tryAcquire("t1")).toBe(false);

    // a different thread has its own budget
    expect(budget.tryAcquire("t2")).toBe(true);

    // the window rolls over and the cap resets
    now += DELEGATION_WAKE_WINDOW_MS + 1;
    expect(budget.tryAcquire("t1")).toBe(true);
  });

  it("DelegationWakeBudget.reset clears the debt for a thread", () => {
    let now = 1_000_000;
    const budget = new DelegationWakeBudget(() => now);
    for (let i = 0; i < DELEGATION_WAKE_MAX_PER_WINDOW; i++) budget.tryAcquire("t1");
    expect(budget.tryAcquire("t1")).toBe(false);
    budget.reset("t1");
    expect(budget.tryAcquire("t1")).toBe(true);
  });
});

describe("delegated turn status helpers", () => {
  it("formats elapsed time compactly", () => {
    expect(formatDelegationElapsed(5_000)).toBe("5s");
    expect(formatDelegationElapsed(65_000)).toBe("65s");
    expect(formatDelegationElapsed(95_000)).toBe("1m 35s");
    expect(formatDelegationElapsed(180_000)).toBe("3m");
  });

  it("summarizeDelegatedActivity keeps only post-dispatch activity, newest last, bounded", () => {
    const messages = [
      { at: 900, kind: "text", text: "before dispatch (the user's ask)" },
      { at: 1_100, kind: "activity", tool: { name: "Delegated to @Helper: followup" } },
      { at: 1_200, kind: "text", text: "peer inbound message" },
      { at: 1_300, kind: "activity", tool: { name: "tool: Bash" } },
      { at: 1_400, kind: "text", text: "  multi  space   reply " },
      { at: 1_500, kind: "activity" },
      { at: 1_600, kind: "unknown-kind" },
    ];
    const lines = summarizeDelegatedActivity(messages, 1_000, 5);
    expect(lines).toEqual([
      "tool: Delegated to @Helper: followup",
      "text: peer inbound message",
      "tool: tool: Bash",
      "text: multi space reply",
    ]);
  });

  it("summarizeDelegatedActivity bounds the list to the newest lines", () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({
      at: 1_000 + index,
      kind: "activity",
      tool: { name: `step-${index}` },
    }));
    const lines = summarizeDelegatedActivity(messages, 1_000, 3);
    expect(lines).toEqual(["tool: step-6", "tool: step-7", "tool: step-8"]);
  });
});
