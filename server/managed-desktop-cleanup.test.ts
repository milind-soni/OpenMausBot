import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import { changedInstanceIds, engineLaunches } from "./config.ts";

// Runs the real cleanup functions sliced from index.ts: importing index.ts would start a server.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
function section(start: string, end: string) {
  // Line-anchored: `function bindTurnComputer(` also matches inside `async function bindTurnComputer(`.
  const lineStart = (marker: string, from: number) => {
    if (from === 0 && source.startsWith(marker)) return 0;
    const at = source.indexOf(`\n${marker}`, from);
    return at < 0 ? -1 : at + 1;
  };
  const from = lineStart(start, 0), to = from < 0 ? -1 : lineStart(end, from + start.length);
  if (from < 0 || to <= from) throw new Error(`Cleanup test section moved: ${start}`);
  return source.slice(from, to);
}
const code = ts.transpileModule([
  // noteTeammatesLeftRunning lives in host/person-stop.ts now and is stubbed below, so the two interrupts are one slice.
  section("async function interruptDirectThread(", "async function interruptAllDirectThreads("),
  section("function releaseTurnResources(", "async function bindTurnComputer("),
  section("async function stopCompanyInstances(", "async function persistProviderInstance("),
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
const reloadProvidersCode = ts.transpileModule(
  section("/** The engine a bot's process in a conversation runs on", "// Config writes replace the engines they change."),
  { compilerOptions: { target: ts.ScriptTarget.ESNext } },
).outputText;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
type Owner = { threadId: string; generation: string };
type Bot = { id: string; busy: boolean; modelSelection: { instanceId: string } };
type Speaker = { botId: string; name: string };
function fixture(kind: "direct" | "group", threadIds = ["first"]) {
  const bots = new Map<string, Bot>(), tasks = new Map<string, { threadId: string; busy: boolean }>();
  const groups = new Map<string, { id: string; busyBotId: string | null }>();
  const owners = new Map<string, Owner>(), generations = new Map<string, string>();
  const directBots = new Map<string, Bot>(), speakers = new Map<string, Speaker>();
  const vmLeases = new Map<string, object>(), approvals = new Set<string>(), screens = new Set<string>(), watched = new Set<string>();
  const autoVmClaims = new Map<string, { owner: { threadId: string; generation: string } }>();
  // An open "may I use your computer?" question, by thread, for the generation that asked it.
  const yourComputerAsks = new Map<string, string>();
  const started = new Map<string, ReturnType<typeof deferred>>(), interrupted = new Map<string, ReturnType<typeof deferred>>();
  const interruptCalls: string[] = [], cancelled: string[] = [], revoked: string[] = [], messages: string[] = [], settled: string[] = [], detached: string[] = [];
  const roomStops: Array<{ threadId: string; status: string; detail: string; byHarness?: boolean }> = [];
  const causes: Array<{ threadId: string; cause: string; interrupted: boolean }> = [];
  // What Stop does and a computer-wait park must not: stop the request, its teammates, the person's message.
  const directRequestOwners = new Map<string, { messageId?: string; stopped: boolean; generations: Set<string> }>();
  const stopAwaiting: string[] = [], patched: Array<[string, string, object]> = [];
  const stoppedCards: string[] = [];
  for (const threadId of threadIds) {
    const bot = { id: threadId, busy: true, modelSelection: { instanceId: "company" } };
    bots.set(threadId, bot); tasks.set(threadId, { threadId, busy: true });
    owners.set(threadId, { threadId, generation: `company-${threadId}` });
    generations.set(threadId, `company-${threadId}`);
    if (kind === "direct") directBots.set(threadId, bot);
    else { speakers.set(threadId, { botId: threadId, name: "Company turn" }); groups.set(threadId, { id: threadId, busyBotId: threadId }); }
    vmLeases.set(threadId, {}); approvals.add(threadId); screens.add(threadId); watched.add(threadId);
    autoVmClaims.set(threadId, { owner: { threadId, generation: `company-${threadId}` } });
    yourComputerAsks.set(threadId, `company-${threadId}`);
    started.set(threadId, deferred()); interrupted.set(threadId, deferred());
  }
  const context = vm.createContext({
    companyShutdown: false, providerInstancesChanging: new Set(),
    providerAuthSessions: { clearInstance() {} }, bus: { detach: (id: string) => detached.push(id) },
    liveTurnByThread: new Map(), stoppedTurnText: (_threadId: string, _turnId: string | undefined, cause: string) => cause,
    turnStops: { stopping: (threadId: string, _turnId: string | undefined, cause: string) => causes.push({ threadId, cause, interrupted: interruptCalls.includes(threadId) }) },
    stoppedTurnOutcome: ({ reason }: { reason: string }) => reason,
    store: {
      get bots() { return [...bots.values()]; },
      tasks: (botId: string) => kind === "direct" ? [tasks.get(botId)] : [],
      bot: (botId: string) => bots.get(botId), groupByThread: (threadId: string) => groups.get(threadId),
      taskByThread: (_botId: string, threadId: string) => tasks.get(threadId),
      appendMessage: (threadId: string) => messages.push(threadId),
      patchMessage: (threadId: string, messageId: string, patch: object) => patched.push([threadId, messageId, patch]),
      setTaskActivity: (_botId: string, threadId: string) => { tasks.get(threadId)!.busy = false; },
      patchGroup: (groupId: string, patch: object) => Object.assign(groups.get(groupId)!, patch),
      setActivity: (botId: string) => { bots.get(botId)!.busy = false; },
    },
    threadBusy: (_botId: string, threadId: string) => tasks.get(threadId)?.busy,
    botForThread: (botId: string, threadId: string) => directBots.get(threadId) ?? bots.get(botId),
    registry: { get: () => ({ adapter: { interruptTurn: (threadId: string) => {
      interruptCalls.push(threadId); started.get(threadId)!.resolve(); return interrupted.get(threadId)!.promise;
    } } }) },
    turnResourceOwners: owners, directTurnGenerationByThread: generations, directTurnBots: directBots, groupSpeakers: speakers,
    activeGroupSpeaker: (groupId: string) => speakers.get(groupId),
    directRequestOwners,
    autoVmClaims,
    cancelYourComputerAsks: (threadId: string, generation?: string) => {
      if (generation === undefined || yourComputerAsks.get(threadId) === generation) yourComputerAsks.delete(threadId);
    },
    turnResources: { release() {} }, cloudComputerPower: { released() {} }, settlingResourceOwners: new Map(), turnComputerResources: new Map(), teamComputerTurns: new Map(),
    coordinator: { stopAwaitingDirect: (threadId: string) => { stopAwaiting.push(threadId); return []; } },
    noteTeammatesLeftRunning() {}, stopParkedCards: (threadId: string) => stoppedCards.push(threadId),
    cancelDirectTurnDispatch: (_botId: string, threadId: string) => cancelled.push(threadId),
    cancelGroupTurnOperations: (_groupId: string, threadId: string, outcome?: { status: string; detail: string; byHarness?: boolean }) => {
      cancelled.push(threadId);
      if (outcome) roomStops.push({ threadId, ...outcome });
    },
    revokeInternalCapabilitiesForThread: (threadId: string) => revoked.push(threadId),
    releaseLocalVmThread: (threadId: string) => vmLeases.delete(threadId),
    stopScreenPoller: (_botId: string, threadId: string) => screens.delete(threadId),
    watchdog: { settle: (threadId: string) => watched.delete(threadId) },
    closeOpenApprovals: (threadId: string) => approvals.delete(threadId),
    finalizeDelegationWatch() {}, routines: { failThread() {} },
    settleDirectFollowup: (generation: string) => settled.push(generation),
  });
  context.runningTurnInstance = (bot: Bot) => context.registry.get(bot.modelSelection.instanceId);
  vm.runInContext(code, context, { filename: "index.ts (Company cleanup ownership fixture)" });
  return {
    bots, tasks, groups, owners, directBots, speakers, vmLeases, approvals, screens, watched,
    autoVmClaims, yourComputerAsks,
    interruptCalls, cancelled, revoked, messages, settled, detached, roomStops, causes,
    directRequestOwners, stopAwaiting, patched,
    context,
    stop: () => context.stopCompanyInstances(["company"]) as Promise<void>,
    interrupt: (threadId: string) => context.interruptDirectThread(threadId, threadId) as Promise<void>,
    park: (threadId: string) => context.interruptParkedTurn(threadId, threadId) as Promise<void>,
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
      autoVmClaims.set(threadId, { owner: { threadId, generation: `personal-${threadId}` } });
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
  // Let the first thread's interrupt finish while the batch's second adapter stays pending.
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

it("stops a Company room turn with the cause, not as the person's Stop", async () => {
  const f = fixture("group"), stopping = f.stop();
  await f.started("first"); f.finish("first"); await stopping;
  expect(f.roomStops).toEqual([{ threadId: "first", status: "stopped", detail: "turn interrupted — the Company connection changed", byHarness: true }]);
});

it("notes the Company cause for each direct turn before interrupting it", async () => {
  const f = fixture("direct", ["first", "second"]), stopping = f.stop();
  await Promise.all([f.started("first"), f.started("second")]); f.finish("first"); f.finish("second"); await stopping;
  expect(f.causes).toEqual(["first", "second"].map(threadId => ({ threadId, cause: "turn interrupted — the Company connection changed", interrupted: false })));
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
    expect(f.yourComputerAsks.has("first")).toBe(false);
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

it("interruptParkedTurn ends the engine's turn without stopping the request or its teammates", async () => {
  const f = fixture("direct");
  f.directRequestOwners.set("first", { messageId: "m1", stopped: false, generations: new Set(["company-first"]) });
  const parked = f.park("first");
  await f.started("first"); f.finish("first"); await parked;
  expect(f.interruptCalls).toEqual(["first"]);
  expect(f.cancelled).toEqual(["first"]);
  expect(f.revoked).toEqual(["first"]);
  expect(f.approvals.has("first")).toBe(false);
  expect(f.directRequestOwners.get("first")).toMatchObject({ stopped: false });
  expect(f.stopAwaiting).toEqual([]);
  expect(f.patched).toEqual([]);

  const g = fixture("direct");
  g.directRequestOwners.set("first", { messageId: "m1", stopped: false, generations: new Set(["company-first"]) });
  const stopped = g.interrupt("first");
  await g.started("first"); g.finish("first"); await stopped;
  expect(g.directRequestOwners.get("first")).toMatchObject({ stopped: true });
  expect(g.stopAwaiting).toEqual(["first"]);
  expect(g.patched).toEqual([["first", "m1", { requestCancelled: true }]]);
});

it("interruptParkedTurn cannot close a replacement generation's approval after awaiting its adapter", async () => {
  const f = fixture("direct"), parked = f.park("first");
  await f.started("first"); f.replace("first"); f.finish("first"); await parked;
  expectPersonalResources(f, "first");
});

it("quitting disposes Company instances without interrupting turns or writing connection-changed cards", async () => {
  const f = fixture("direct");
  f.context.companyShutdown = true;
  await f.stop();
  expect(f.interruptCalls).toEqual([]);
  expect(f.messages).toEqual([]);
  expect(f.detached).toEqual(["company"]);
  expect(f.tasks.get("first")?.busy).toBe(true);
});

function reloadFixture() {
  type Thread = { botId: string; threadId: string; engine: string; busy: boolean };
  const threads: Thread[] = [
    { botId: "eli", threadId: "eli-work", engine: "compat", busy: true },
    { botId: "mira", threadId: "mira-work", engine: "claude", busy: true },
    { botId: "eli", threadId: "eli-idle", engine: "compat", busy: false },
    { botId: "mira", threadId: "mira-idle", engine: "claude", busy: false },
  ];
  let configs: Record<string, { driver: string; environment?: Record<string, string> }> = {
    compat: { driver: "openai-compat", environment: { OPENAI_COMPAT_API_KEY: "k1" } },
    claude: { driver: "claudeAgent" },
  };
  // Two rooms, each with a member speaking on one engine and holding a bearer in each.
  const rooms = new Map([["room-compat", { botId: "eli", engine: "compat" }], ["room-claude", { botId: "mira", engine: "claude" }]]);
  const log: string[] = [], settled: Array<{ generation: string; text: string }> = [], revoked: string[] = [];
  const slot = (botId: string) => [`${botId} agents`, { grants: "", token: `t-${botId}` }] as const;
  const bearers = new Map([...threads.map(thread => [thread.threadId, new Map([slot(thread.botId)])] as const),
    ...[...rooms.keys()].map(threadId => [threadId, new Map([slot("eli"), slot("mira")])] as const)]);
  const capabilities = new Map([...threads.filter(thread => thread.busy), ...[...rooms].map(([threadId, room]) => ({ threadId, ...room }))]
    .map(turn => [`cap-${turn.threadId}`, { botId: turn.botId, threadId: turn.threadId }]));
  const context = vm.createContext({
    providerFleetReloading: false, providerInstancesChanging: new Set<string>(),
    providerConfigs: () => configs, changedInstanceIds, engineLaunches: (launched: typeof configs) => engineLaunches(launched, {}),
    decorateHostedProvider: undefined,
    internalCapabilities: capabilities, sessionCredentials: bearers,
    revokeEarlierTurnCapabilities: (threadId: string) => {
      revoked.push(threadId);
      for (const [token, capability] of capabilities) if (capability.threadId === threadId) capabilities.delete(token);
    },
    runningTurnEngines: new Map([...threads.filter(thread => thread.busy), ...[...rooms].map(([threadId, room]) => ({ threadId, ...room }))]
      .map(thread => [thread.threadId, { instanceId: thread.engine }])),
    botForThread: (botId: string) => ({ modelSelection: { instanceId: botId === "eli" ? "compat" : "claude" } }),
    store: {
      bots: [{ id: "eli" }, { id: "mira" }],
      tasks: (botId: string) => threads.filter(thread => thread.botId === botId),
      taskByThread: (_botId: string, threadId: string) => threads.find(thread => thread.threadId === threadId),
      appendMessage: (threadId: string, message: { tool: { name: string } }) => log.push(`message:${threadId}:${message.tool.name}`),
      setTaskActivity: (_botId: string, threadId: string) => { threads.find(thread => thread.threadId === threadId)!.busy = false; },
      groupByThread: (threadId: string) => rooms.has(threadId) ? { id: `group-${threadId}` } : undefined,
      patchGroup() {}, setActivity() {},
    },
    activeGroupSpeaker: () => undefined,
    threadBusy: (_botId: string, threadId: string) => threads.find(thread => thread.threadId === threadId)!.busy,
    groupSpeakers: new Map([...rooms].map(([threadId, room]) => [threadId, { botId: room.botId }])), turnResourceOwners: new Map(threads.map(thread => [thread.threadId, { threadId: thread.threadId, generation: `gen-${thread.threadId}` }])),
    providerAuthSessions: { clearInstance: (id: string) => log.push(`auth:${id}`) },
    bus: { detach: (id: string) => log.push(`detach:${id}`), attach: (instances: Array<{ instanceId: string }>) => log.push(`attach:${instances.map(instance => instance.instanceId)}`) },
    registry: {
      dispose: async (id: string) => { log.push(`dispose:${id}`); },
      load: async (loaded: object) => { log.push(`load:${Object.keys(loaded)}`); },
      get: (id: string) => ({ instanceId: id }),
    },
    cancelDirectTurnDispatch: (_botId: string, threadId: string) => log.push(`cancel:${threadId}`),
    cancelGroupTurnOperations: (_groupId: string, threadId: string, outcome: { status: string; detail: string; byHarness?: boolean }) =>
      log.push(`room-stop:${threadId}:${outcome.status}:${outcome.detail}:${outcome.byHarness === true}`),
    liveTurnByThread: new Map(),
    stoppedTurnText: (threadId: string, _turnId: string | undefined, cause: string) => `${cause} (${threadId})`,
    stoppedTurnOutcome: ({ reason }: { reason: string }) => reason,
    stopScreenPoller() {}, releaseLocalVmThread() {}, releaseTurnResources() {}, endForeignTurns() {}, vpsThreadEnded() {},
    watchdog: { settle() {} }, closeOpenApprovals() {}, directTurnBots: new Map(),
    finalizeDelegationWatch: (_threadId: string, _ok: boolean, _reply: string, why: string) => log.push(`delegation:${why}`),
    routines: { failThread() {} }, failedTurnTool: (name: string) => ({ name, ok: false }),
    settleDirectFollowup: (generation: string, outcome: { text: string }) => settled.push({ generation, text: outcome.text }),
    retryDelegationsWaitingOn() {},
    drainQueuedSends() {},
  });
  vm.runInContext(reloadProvidersCode, context, { filename: "index.ts (provider reload fixture)" });
  const save = (next: typeof configs) => {
    const before = configs;
    configs = next;
    return context.reloadProviders(engineLaunches(before, {})) as Promise<void>;
  };
  const held = () => Object.fromEntries([...bearers].map(([threadId, slots]) => [threadId, [...slots.keys()]]));
  return { threads, log, settled, revoked, held, save, configs: () => configs, context };
}

it("saving the same provider settings again interrupts no turn and replaces no engine", async () => {
  const f = reloadFixture();
  const before = f.held();
  await f.save(structuredClone(f.configs()));
  expect(f.log).toEqual([]);
  expect(f.settled).toEqual([]);
  expect(f.revoked).toEqual([]);
  expect(f.held()).toEqual(before);
  expect(f.threads.filter(thread => thread.busy).map(thread => thread.threadId)).toEqual(["eli-work", "mira-work"]);
});

it("a changed key replaces only its engine and tells only that engine's requesters why", async () => {
  const f = reloadFixture();
  await f.save({ ...f.configs(), compat: { driver: "openai-compat", environment: { OPENAI_COMPAT_API_KEY: "k2" } } });
  expect(f.log.filter(line => line.includes("claude") || line.includes("mira"))).toEqual([]);
  expect(f.revoked).toEqual(["eli-work", "room-compat"]);
  expect(f.held()).toEqual({
    "eli-work": [], "eli-idle": [], "mira-work": ["mira agents"], "mira-idle": ["mira agents"],
    "room-compat": ["mira agents"], "room-claude": ["mira agents"],
  });
  expect(f.log).toEqual(expect.arrayContaining(["auth:compat", "detach:compat", "cancel:eli-work", "load:compat", "attach:compat",
    "message:eli-work:turn interrupted — provider settings changed",
    "room-stop:room-compat:stopped:turn interrupted — provider settings changed:true"]));
  expect(f.settled).toEqual([{ generation: "gen-eli-work", text: "turn interrupted — provider settings changed (eli-work)" }]);
  expect(f.threads.find(thread => thread.threadId === "mira-work")?.busy).toBe(true);
  expect(f.threads.find(thread => thread.threadId === "eli-work")?.busy).toBe(false);
  expect(f.context.providerInstancesChanging.size).toBe(0);
  expect(f.context.providerFleetReloading).toBe(false);
});

it("ends a room stopped by the harness with its cause, and one the person stopped as theirs", () => {
  const run = (outcome?: { status: "stopped"; detail: string; byHarness: true }) => {
    const calls: string[] = [];
    const context = vm.createContext({
      coordinator: {
        cancelRoom: (...args: string[]) => calls.push(`assignments:${args.join("|")}`),
        stopAwaitingDirect: (threadId: string) => { calls.push(`stop-awaiting:${threadId}`); return ["mid-turn teammate"]; },
      },
      stopParkedCards: (threadId: string) => calls.push(`cards-stopped:${threadId}`),
      noteTeammatesLeftRunning: (threadId: string, left: string[]) => calls.push(`left-running:${threadId}:${left.join(",")}`),
      roomMemberLock: { releaseThread: (threadId: string) => calls.push(`member-claims:${threadId}`) },
      groupTurnOperations: new Map([["g", new Set([{ threadId: "room", cancellation: new AbortController() }])]]),
      finishGroupGoalRun: (_groupId: string, _operation: unknown, status: string, detail: string) => calls.push(`goal:${status}|${detail}`),
      markCancelledProviderHandshake() {},
    });
    vm.runInContext(ts.transpileModule(section("function cancelGroupTurnOperations(", "function groupProviderHandshakeStarted("),
      { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText, context);
    context.cancelGroupTurnOperations("g", "room", outcome);
    return calls;
  };
  expect(run({ status: "stopped", detail: "Turn interrupted — provider settings changed.", byHarness: true })).toEqual([
    "assignments:g|room|Turn interrupted — provider settings changed.|failed",
    "member-claims:room",
    "goal:stopped|Turn interrupted — provider settings changed.",
  ]);
  expect(run()).toEqual([
    "cards-stopped:room", "stop-awaiting:room", "left-running:room:mid-turn teammate",
    "assignments:g|room", "member-claims:room", "goal:stopped|Stopped by you.",
  ]);
});
