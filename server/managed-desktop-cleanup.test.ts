import { expect, it } from "vitest";
import { createProviderFleet } from "./provider-fleet.ts";
import { createTurnCleanup } from "./turn-cleanup.ts";

// Construct the real cleanup and provider-fleet factories with synthetic
// state and adapters; this is an ownership-race regression, not proof of a
// real provider or conversation workflow.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
type Owner = { threadId: string; generation: string };
type Bot = { id: string; busy: boolean; modelSelection: { instanceId: string } };
type Speaker = { botId: string; name: string };
function fixture(kind: "direct" | "group", threadIds = ["first"]) {
  const bots = new Map<string, Bot>(), tasks = new Map<string, { threadId: string; busy: boolean; title: string }>();
  const groups = new Map<string, { id: string; busyBotId: string | null }>();
  const owners = new Map<string, Owner>(), generations = new Map<string, string>();
  const directBots = new Map<string, Bot>(), speakers = new Map<string, Speaker>();
  const vmLeases = new Map<string, object>(), approvals = new Set<string>(), screens = new Set<string>(), watched = new Set<string>();
  const started = new Map<string, ReturnType<typeof deferred>>(), interrupted = new Map<string, ReturnType<typeof deferred>>();
  const interruptCalls: string[] = [], cancelled: string[] = [], revoked: string[] = [], messages: string[] = [], settled: string[] = [], detached: string[] = [];
  let companyShutdown = false;
  for (const threadId of threadIds) {
    const bot = { id: threadId, busy: true, modelSelection: { instanceId: "company" } };
    bots.set(threadId, bot); tasks.set(threadId, { threadId, busy: true, title: "Work" });
    owners.set(threadId, { threadId, generation: `company-${threadId}` });
    generations.set(threadId, `company-${threadId}`);
    if (kind === "direct") directBots.set(threadId, bot);
    else { speakers.set(threadId, { botId: threadId, name: "Company turn" }); groups.set(threadId, { id: threadId, busyBotId: threadId }); }
    vmLeases.set(threadId, {}); approvals.add(threadId); screens.add(threadId); watched.add(threadId);
    started.set(threadId, deferred()); interrupted.set(threadId, deferred());
  }
  const instances: Array<{ instanceId: string; adapter: { interruptTurn(threadId: string): Promise<void> } }> = [
    {
      instanceId: "company",
      adapter: {
        interruptTurn(threadId: string) {
          interruptCalls.push(threadId); started.get(threadId)!.resolve(); return interrupted.get(threadId)!.promise;
        },
      },
    },
  ];
  const store = {
    get bots() { return [...bots.values()]; },
    tasks: (botId: string) => kind === "direct" ? [tasks.get(botId)!] : [],
    bot: (botId: string) => bots.get(botId), groupByThread: (threadId: string) => groups.get(threadId),
    taskByThread: (_botId: string, threadId: string) => tasks.get(threadId),
    appendMessage: (threadId: string) => { messages.push(threadId); },
    setTaskActivity: (_botId: string, threadId: string) => { tasks.get(threadId)!.busy = false; },
    patchGroup: (groupId: string, patch: { busyBotId?: string | null }) => Object.assign(groups.get(groupId)!, patch),
    setActivity: (botId: string) => { bots.get(botId)!.busy = false; },
  };
  const stopScreenPoller = (_botId: string, threadId?: string) => { if (threadId) screens.delete(threadId); };
  const cancelDirectTurnDispatch = (_botId: string, threadId?: string) => { if (threadId) cancelled.push(threadId); };
  const cancelGroupTurnOperations = (_groupId: string, threadId?: string) => { if (threadId) cancelled.push(threadId); };
  const revokeInternalCapabilitiesForThread = (threadId: string) => revoked.push(threadId);
  const closeOpenApprovals = (threadId: string) => approvals.delete(threadId);
  const runningTurnInstance = (bot: Bot) => instances.find(instance => instance.instanceId === bot.modelSelection.instanceId) ?? null;
  const cleanup = createTurnCleanup({
    store,
    turnResources: { release() {} },
    turnResourceOwners: owners,
    turnComputerResources: new Map(),
    teamComputerTurns: new Map(),
    directTurnGenerationByThread: generations,
    stopScreenPoller,
    roomHandoffs: () => ({ stopAwaitingDirect: () => [] }),
    botForThread: (botId: string, threadId: string) => directBots.get(threadId) ?? bots.get(botId),
    cancelDirectTurnDispatch,
    revokeInternalCapabilitiesForThread,
    runningTurnInstance,
    closeOpenApprovals,
  });
  const fleet = createProviderFleet({
    store,
    cfg: {},
    registry: {
      load: async () => {},
      get: (id: string) => instances.find(instance => instance.instanceId === id) ?? null,
      instances: () => instances,
      dispose: async () => {},
      disposeAll: async () => {},
    },
    bus: { attach() {}, detach: (id: string) => detached.push(id), detachAll() {} },
    sessions: { clear() {}, clearInstance() {} },
    watchdog: { settle: (threadId: string) => { watched.delete(threadId); } },
    routines: () => null,
    desktop: { restore: async () => {} },
    turns: cleanup,
    companyShutdown: () => companyShutdown,
    admission: {
      threadBusy: (_botId: string, threadId: string) => Boolean(tasks.get(threadId)?.busy),
      botForThread: (botId: string, threadId: string) => directBots.get(threadId) ?? bots.get(botId) ?? null,
      turnResourceOwners: owners,
      directTurnGenerationByThread: generations,
      directTurnBots: directBots,
    },
    cleanup: {
      stopScreenPoller,
      releaseLocalVmThread: (threadId: string) => { vmLeases.delete(threadId); },
      closeOpenApprovals,
      revokeInternalCapabilitiesForThread,
      revokeAllInternalCapabilities() {},
      runningTurnInstance,
      settleDirectFollowup: (generation?: string) => { if (generation) settled.push(generation); },
      finalizeDelegationWatch() { return false; },
      cancelGroupTurnOperations,
      cancelDirectTurnDispatch,
    },
    speakers: { groupSpeakers: speakers },
    vps: { activeVpsThreads: new Map<string, string>() },
    persistence: { saveConfig() {}, instanceConfigs: () => ({}), resetPathCache() {} },
    drains: { drainQueuedSends() {}, drainConnectorResumes() {}, drainSecretResumes() {}, drainTeamSetupResumes() {}, retryDelegationsWaitingOn() {} },
  });
  for (const threadId of threadIds) {
    cleanup.autoVmClaims.set(threadId, { owner: { threadId, generation: `company-${threadId}` }, claim: () => Promise.resolve() });
  }
  return {
    bots, tasks, groups, owners, directBots, speakers, vmLeases, approvals, screens, watched,
    autoVmClaims: cleanup.autoVmClaims,
    interruptCalls, cancelled, revoked, messages, settled, detached,
    stop: () => fleet.stopCompanyInstances(["company"]),
    interrupt: (threadId: string) => cleanup.interruptDirectThread(threadId, threadId),
    setCompanyShutdown: (value: boolean) => { companyShutdown = value; },
    started: (threadId: string) => started.get(threadId)!.promise,
    finish: (threadId: string) => interrupted.get(threadId)!.resolve(),
    replace: (threadId: string, replaceSpeaker = true) => {
      const bot = { id: threadId, busy: true, modelSelection: { instanceId: "personal" } };
      bots.set(threadId, bot); tasks.get(threadId)!.busy = true;
      owners.set(threadId, { threadId, generation: `personal-${threadId}` });
      generations.set(threadId, `personal-${threadId}`);
      if (kind === "direct") directBots.set(threadId, bot);
      else if (replaceSpeaker) speakers.set(threadId, { botId: threadId, name: "Personal turn" });
      vmLeases.set(threadId, {}); approvals.add(threadId); screens.add(threadId); watched.add(threadId);
      cleanup.autoVmClaims.set(threadId, { owner: { threadId, generation: `personal-${threadId}` }, claim: () => Promise.resolve() });
    },
  };
}

function expectPersonalResources(f: ReturnType<typeof fixture>, threadId: string) {
  expect(f.owners.get(threadId)?.generation).toBe(`personal-${threadId}`);
  expect(f.autoVmClaims.get(threadId)?.owner?.generation).toBe(`personal-${threadId}`);
  expect(f.vmLeases.has(threadId)).toBe(true);
  expect(f.approvals.has(threadId)).toBe(true);
  expect(f.screens.has(threadId)).toBe(true);
  expect(f.watched.has(threadId)).toBe(true);
  expect(f.messages).not.toContain(threadId);
}

it("preserves a personal direct turn started while a slower Company sibling is stopping", async () => {
  const f = fixture("direct", ["first", "slow"]);
  const stopping = f.stop();
  await Promise.all([f.started("first"), f.started("slow")]);
  f.finish("first");
  // Let interruptDirectThread finish for the first thread while the batch's
  // second adapter remains pending, then simulate a new personal dispatch.
  for (let count = 0; count < 5; count++) await Promise.resolve();
  f.replace("first");
  f.finish("slow"); await stopping;
  expectPersonalResources(f, "first");
  expect(f.directBots.get("first")?.modelSelection.instanceId).toBe("personal");
  expect(f.tasks.get("first")?.busy).toBe(true);
  expect(f.tasks.get("slow")?.busy).toBe(false);
  expect(f.owners.has("slow")).toBe(false);
  expect(f.settled).toContain("company-first");
  expect(f.detached).toEqual(["company"]);
});

it("interruptDirectThread cannot close a replacement generation's approval after awaiting its adapter", async () => {
  const f = fixture("direct"), interrupted = f.interrupt("first");
  await f.started("first"); f.replace("first"); f.finish("first"); await interrupted;
  expectPersonalResources(f, "first");
});

it("preserves a group replacement's speaker, resources and busy state after the old interrupt resolves", async () => {
  const f = fixture("group"), stopping = f.stop();
  await f.started("first"); f.replace("first");
  const speaker = f.speakers.get("first");
  f.finish("first"); await stopping;
  expectPersonalResources(f, "first");
  expect(f.speakers.get("first")).toBe(speaker);
  expect(f.groups.get("first")?.busyBotId).toBe("first");
  expect(f.bots.get("first")?.busy).toBe(true);
});

it("skips a later snapshot entry replaced while an earlier group interrupt is pending", async () => {
  const f = fixture("group", ["first", "later"]), stopping = f.stop();
  await f.started("first"); f.replace("later"); f.finish("first"); await stopping;
  expectPersonalResources(f, "later");
  expect(f.interruptCalls).toEqual(["first"]);
  expect(f.cancelled).toEqual(["first"]);
  expect(f.revoked).toEqual(["first"]);
  expect(f.speakers.get("later")?.name).toBe("Personal turn");
});

it("also fences group resource-generation changes when the speaker object is unchanged", async () => {
  const f = fixture("group"), stopping = f.stop();
  await f.started("first"); f.replace("first", false); f.finish("first"); await stopping;
  expectPersonalResources(f, "first");
  expect(f.speakers.has("first")).toBe(true);
  expect(f.groups.get("first")?.busyBotId).toBe("first");
});

for (const kind of ["direct", "group"] as const) {
  it(`still releases the original ${kind} turn when no replacement has claimed it`, async () => {
    const f = fixture(kind), stopping = f.stop();
    await f.started("first"); f.finish("first"); await stopping;
    expect(f.owners.has("first")).toBe(false);
    expect(f.vmLeases.has("first")).toBe(false);
    expect(f.autoVmClaims.has("first")).toBe(false);
    expect(f.approvals.has("first")).toBe(false);
    expect(f.watched.has("first")).toBe(false);
    if (kind === "direct") {
      expect(f.directBots.has("first")).toBe(false);
      expect(f.tasks.get("first")?.busy).toBe(false);
      expect(f.messages).toEqual(["first"]);
    } else {
      expect(f.speakers.has("first")).toBe(false);
      expect(f.groups.get("first")?.busyBotId).toBe(null);
      expect(f.bots.get("first")?.busy).toBe(false);
    }
    expect(f.detached).toEqual(["company"]);
  });
}

it("quitting disposes Company instances without interrupting turns or writing connection-changed cards", async () => {
  const f = fixture("direct");
  f.setCompanyShutdown(true);
  await f.stop();
  expect(f.interruptCalls).toEqual([]);
  expect(f.messages).toEqual([]);
  expect(f.detached).toEqual(["company"]);
  expect(f.tasks.get("first")?.busy).toBe(true);
});

it("reattaches rebuilt personal providers before a Company restore failure", async () => {
  const order: string[] = [];
  const personal = { instanceId: "personal" };
  const cleanup = createTurnCleanup({
    store: { taskByThread: () => undefined, bot: () => undefined, appendMessage() {} },
    turnResources: { release() {} },
    turnResourceOwners: new Map(),
    turnComputerResources: new Map(),
    teamComputerTurns: new Map(),
    directTurnGenerationByThread: new Map(),
    stopScreenPoller() {},
    roomHandoffs: () => ({ stopAwaitingDirect: () => [] }),
    botForThread: () => null,
    cancelDirectTurnDispatch() {},
    revokeInternalCapabilitiesForThread() {},
    runningTurnInstance: () => null,
    closeOpenApprovals() {},
  });
  const fleet = createProviderFleet({
    store: {
      bots: [],
      tasks: () => [],
      bot: () => undefined,
      groupByThread: () => undefined,
      taskByThread: () => undefined,
      appendMessage() {},
      setTaskActivity() {},
      patchGroup() {},
      setActivity() {},
    },
    cfg: {},
    registry: {
      load: async () => { order.push("load-personal"); },
      get: () => null,
      instances: () => [personal],
      dispose: async () => {},
      disposeAll: async () => { order.push("dispose"); },
    },
    bus: {
      detachAll: () => { order.push("detach"); },
      attach: (instances: Array<{ instanceId: string }>) => { order.push(`attach:${instances.map(instance => instance.instanceId).join(",")}`); },
      detach() {},
    },
    sessions: { clear: () => { order.push("clear-auth"); }, clearInstance() {} },
    watchdog: { settle() {} },
    routines: () => null,
    desktop: { restore: async () => { order.push("restore-company"); throw new Error("Fixture Company restore failure"); } },
    turns: cleanup,
    companyShutdown: () => false,
    admission: { threadBusy: () => false, botForThread: () => null, turnResourceOwners: new Map(), directTurnGenerationByThread: new Map(), directTurnBots: new Map() },
    cleanup: {
      stopScreenPoller() {},
      releaseLocalVmThread() {},
      closeOpenApprovals() {},
      revokeInternalCapabilitiesForThread() {},
      revokeAllInternalCapabilities: () => { order.push("revoke-capabilities"); },
      runningTurnInstance: () => null,
      settleDirectFollowup() {},
      finalizeDelegationWatch() { return false; },
      cancelGroupTurnOperations() {},
      cancelDirectTurnDispatch() {},
    },
    speakers: { groupSpeakers: new Map() },
    vps: { activeVpsThreads: new Map() },
    persistence: { saveConfig() {}, instanceConfigs: () => ({}), resetPathCache() {} },
    drains: { drainQueuedSends() {}, drainConnectorResumes() {}, drainSecretResumes() {}, drainTeamSetupResumes() {}, retryDelegationsWaitingOn() {} },
  });

  await expect(fleet.reloadProviders()).rejects.toThrow("Fixture Company restore failure");
  expect(order).toEqual([
    "clear-auth", "revoke-capabilities", "detach", "dispose", "load-personal", "attach:personal", "restore-company",
  ]);
  expect(fleet.providerFleetReloading).toBe(false);
});
