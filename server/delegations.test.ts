// Async peer handoff (`delegate_bot`) — pure logic. Each test stands up a
// real Store with throwaway bots, a fake comms-bus (records broadcasts),
// and a runTarget stub that captures the would-be turn so the test can
// assert what would have been dispatched to the harness. The harness itself
// stays out of these — the integration happens in comms.test.ts (the full
// e2e through the agents proxy + fake ACP CLI).
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  buildDelegationFailurePrompt,
  buildDelegationRevivalPrompt,
  DELEGATION_WAKE_MAX_PER_WINDOW,
  DELEGATION_WAKE_WINDOW_MS,
  DelegationWakeBudget,
  drainDelegations,
  findDelegationReceipt,
  formatDelegationElapsed,
  MAX_BUSY_ATTEMPTS,
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
import { effectiveTaskRuntimePolicy, runtimePolicyFingerprint } from "./bot-runtime-policy.ts";
import { Store, type BotRecord } from "./store.ts";

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
 * tests need to wait for its async steps to land. */
async function waitFor<T>(predicate: () => T | undefined | false, timeout = 2_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = predicate();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
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
      { sourceThreadId: from.threadId, toBotId: target.id, reason: "followup" },
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

  it("records hash-only policy evidence and fails closed on malformed overrides", () => {
    store.setChiefOfStaff(from.id);
    const queued = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "bounded work",
      runtimePolicyOverride: { maxToolAgentSteps: 12 },
      depth: 0,
    }, 1);
    expect(queued.result).toBe("ok");
    expect(queued.evidence).toMatchObject({
      evidenceKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      runtimePolicyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      runtimePolicyOverrideFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(queued.evidence)).not.toContain("maxToolAgentSteps");

    const invalid = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "bad policy",
      runtimePolicyOverride: { idleTimeoutMinutes: 0 },
      depth: 0,
    }, 1);
    expect(invalid.result).toBe("invalid_runtime_policy");

    store.setChiefOfStaff(null);
    const unauthorized = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "unauthorized policy",
      runtimePolicyOverride: { maxToolAgentSteps: 12 },
      depth: 0,
    }, 1);
    expect(unauthorized.result).toBe("runtime_policy_chief_only");
  });

  it("uses locale-independent canonicalization for evidence keys", () => {
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "I", depth: 0 }, 1);
    expect(queued.result).toBe("ok");
    const policyFingerprint = runtimePolicyFingerprint(effectiveTaskRuntimePolicy(target.runtimePolicy, undefined));
    const expected = createHash("sha256")
      .update(["i", "", policyFingerprint, "none"].join("\n\u241f\n"), "utf8")
      .digest("hex");
    expect(queued.evidence?.evidenceKey).toBe(expected);
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

  it("passes runtime policy evidence to the target runner and task record", async () => {
    store.patchBot(from.id, { chiefOfStaff: true });
    const queued = queueDelegation(
      commsBus,
      from,
      {
        toBotId: target.id,
        message: "run with bounded policy",
        runtimePolicyOverride: { maxToolAgentSteps: 12 },
        depth: 0,
      },
      1,
    );
    expect(queued.result).toBe("ok");
    if (queued.result !== "ok") return;

    let receivedEvidence: unknown;
    drainDelegations(
      commsBus,
      approvalBus,
      from.threadId,
      (toBotId, message, commsDepth, sourceThreadId, channel, taskId, evidence) => {
        receivedEvidence = evidence;
        runTargetCalls.push({ toBotId, message, commsDepth, sourceThreadId });
        void channel;
        void taskId;
      },
    );

    await waitFor(() => receivedEvidence !== undefined);
    expect(receivedEvidence).toEqual(queued.evidence);
    const task = store.taskByThread(target.id, target.threadId);
    expect(task?.runtimePolicyFingerprint).toBe(queued.evidence?.runtimePolicyFingerprint);
    expect(task?.runtimePolicyOverrideFingerprint).toBe(
      queued.evidence?.runtimePolicyOverrideFingerprint,
    );
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
    expect(chip.tool?.name).toBe("Delegation to @Helper waiting — they're busy (retry 1/3 when they finish)");
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
import { _loadPending, _resetPending, discardDelegations, pendingThreads } from "./delegations.ts";

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
});

describe("busy retries and receipts", () => {
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

  it("leaves a terminal evidence receipt when Chief authority is revoked", async () => {
    store.setChiefOfStaff(from.id);
    const queued = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "bounded work",
      runtimePolicyOverride: { maxToolAgentSteps: 1 },
      depth: 0,
    }, 1);
    expect(queued.result).toBe("ok");
    store.setChiefOfStaff(null);
    const runTarget = vi.fn();
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => _pendingCount(from.threadId) === 0);
    expect(runTarget).not.toHaveBeenCalled();
    expect(findDelegationReceipt(queued.id!)).toMatchObject({
      status: "denied",
      result: "only a Chief of Staff may set a runtime policy override",
      evidence: queued.evidence,
    });
  });

  it("reuses the queue-time policy snapshot for evidence, task, and dispatch", async () => {
    store.setChiefOfStaff(from.id);
    const queued = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "snapshot this",
      runtimePolicyOverride: { maxToolAgentSteps: 2 },
      depth: 0,
    }, 1);
    expect(queued.result).toBe("ok");
    store.patchBot(target.id, { runtimePolicy: { maxToolAgentSteps: 99 } });
    const dispatched: unknown[][] = [];
    drainDelegations(commsBus, approvalBus, from.threadId, (...args: unknown[]) => void dispatched.push(args));
    await waitFor(() => dispatched.length === 1 && _pendingCount(from.threadId) === 0);
    const policy = dispatched[0]![7] as Parameters<typeof runtimePolicyFingerprint>[0];
    expect(policy.maxToolAgentSteps).toBe(2);
    expect(runtimePolicyFingerprint(policy)).toBe(queued.evidence?.runtimePolicyFingerprint);
    expect(store.taskByThread(target.id, target.threadId)?.runtimePolicySnapshot?.maxToolAgentSteps).toBe(2);
  });

  it("keeps a handoff queued while the target is busy and dispatches on the retry drain", async () => {
    store.patchBot(target.id, { busy: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
    expect(queued.result).toBe("ok");
    const taskId = queued.id!;

    const dispatched: unknown[][] = [];
    const runTarget = (...args: unknown[]) => void dispatched.push(args);

    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chipCount("waiting — they're busy (retry 1/") === 1);
    expect(dispatched).toHaveLength(0);
    expect(_pendingCount(from.threadId)).toBe(1);
    // this is the set a settling target turn re-drains
    expect(threadsWaitingOn(target.id)).toEqual([from.threadId]);
    expect(pendingDelegationInfo(taskId)).toMatchObject({ toBotId: target.id, attempts: 1 });

    store.patchBot(target.id, { busy: false });
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => dispatched.length === 1);
    expect(_pendingCount(from.threadId)).toBe(0);
    // the task id rides into the dispatched turn so the receipt can be keyed
    expect(dispatched[0][5]).toBe(taskId);
    expect(pendingDelegationInfo(taskId)).toBeNull();
  });

  it("gives up after the bounded retries, with a receipt the delegator can read", async () => {
    store.patchBot(target.id, { busy: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
    const taskId = queued.id!;
    const runTarget = () => undefined;
    for (let round = 1; round < MAX_BUSY_ATTEMPTS; round++) {
      drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
      await waitFor(() => chipCount(`retry ${round}/`) === 1);
      // One retry is charged per distinct busy period. Releasing the wait
      // models that turn settling before another turn claims the target.
      expect(releaseDelegationsWaitingOn(target.id)).toEqual([from.threadId]);
    }
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => _pendingCount(from.threadId) === 0);
    expect(chipCount("canceled — still busy after")).toBe(1);
    expect(findDelegationReceipt(taskId)).toMatchObject({
      status: "busy_gave_up",
      toBotName: "Helper",
      sourceThreadId: from.threadId,
    });
  });

  it("does not burn busy retries when an unrelated drain is requested", async () => {
    store.patchBot(target.id, { busy: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
    const taskId = queued.id!;
    const runTarget = vi.fn();

    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chipCount("retry 1/") === 1);

    // A source-thread redrain can happen while an approval for another
    // item settles. It must not count the same continuously busy turn again.
    for (let index = 0; index < MAX_BUSY_ATTEMPTS + 1; index++) {
      drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pendingDelegationInfo(taskId)?.attempts).toBe(1);
    expect(chipCount("canceled — still busy after")).toBe(0);

    store.patchBot(target.id, { busy: false });
    expect(releaseDelegationsWaitingOn(target.id)).toEqual([from.threadId]);
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1);
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
