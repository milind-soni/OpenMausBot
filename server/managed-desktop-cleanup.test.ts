import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import { changedInstanceIds, engineLaunches } from "./config.ts";

// Execute the actual cleanup functions without importing index.ts, which would
// start a server. State and adapters are synthetic; this is an ownership-race
// regression, not proof of a real provider or conversation workflow.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
function section(start: string, end: string) {
  // Anchor both markers to the start of a line. `function bindTurnComputer(`
  // also matches INSIDE `async function bindTurnComputer(`, which silently cut
  // the slice after the `async ` and left it dangling — the extracted code then
  // died with `ReferenceError: async is not defined` instead of failing here
  // with a readable "section moved". Anchoring makes drift loud again.
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
  section("async function interruptDirectThread(", "/** Stop left teammates"),
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
  const started = new Map<string, ReturnType<typeof deferred>>(), interrupted = new Map<string, ReturnType<typeof deferred>>();
  const interruptCalls: string[] = [], cancelled: string[] = [], revoked: string[] = [], messages: string[] = [], settled: string[] = [], detached: string[] = [];
  const roomStops: Array<{ threadId: string; status: string; detail: string; byHarness?: boolean }> = [];
  const causes: Array<{ threadId: string; cause: string; interrupted: boolean }> = [];
  // The parked-resume seam (#1651): releaseTurnResources queues the drain
  // when a parked turn waits behind the release. Recorded stubs, so the
  // extracted code runs against the same names the real module sees.
  const pendingComputerResumes = new Map<string, { threadId: string }>();
  const resumeDrains: number[] = [];
  const microtasks: Array<() => void> = [];
  for (const threadId of threadIds) {
    const bot = { id: threadId, busy: true, modelSelection: { instanceId: "company" } };
    bots.set(threadId, bot); tasks.set(threadId, { threadId, busy: true });
    owners.set(threadId, { threadId, generation: `company-${threadId}` });
    generations.set(threadId, `company-${threadId}`);
    if (kind === "direct") directBots.set(threadId, bot);
    else { speakers.set(threadId, { botId: threadId, name: "Company turn" }); groups.set(threadId, { id: threadId, busyBotId: threadId }); }
    vmLeases.set(threadId, {}); approvals.add(threadId); screens.add(threadId); watched.add(threadId);
    autoVmClaims.set(threadId, { owner: { threadId, generation: `company-${threadId}` } });
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
    directRequestOwners: new Map(),
    autoVmClaims,
    turnResources: { release() {} }, settlingResourceOwners: new Map(), turnComputerResources: new Map(), teamComputerTurns: new Map(),
    roomHandoffs: { stopAwaitingDirect() {} },
    noteTeammatesLeftRunning() {},
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
    pendingComputerResumes,
    drainComputerResumes: () => { resumeDrains.push(pendingComputerResumes.size); },
    queueMicrotask: (run: () => void) => { microtasks.push(run); },
  });
  context.runningTurnInstance = (bot: Bot) => context.registry.get(bot.modelSelection.instanceId);
  vm.runInContext(code, context, { filename: "index.ts (Company cleanup ownership fixture)" });
  return {
    bots, tasks, groups, owners, directBots, speakers, vmLeases, approvals, screens, watched,
    autoVmClaims,
    interruptCalls, cancelled, revoked, messages, settled, detached, roomStops, causes,
    pendingComputerResumes, resumeDrains, microtasks,
    flushMicrotasks: () => { for (const run of microtasks.splice(0)) run(); },
    context,
    stop: () => context.stopCompanyInstances(["company"]) as Promise<void>,
    interrupt: (threadId: string) => context.interruptDirectThread(threadId, threadId) as Promise<void>,
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

// A room's assignments fail with the cause and its goal run says it, so
// neither the assigner nor the person reads a Company change as their Stop.
it("stops a Company room turn with the cause, not as the person's Stop", async () => {
  const f = fixture("group"), stopping = f.stop();
  await f.started("first"); f.finish("first"); await stopping;
  expect(f.roomStops).toEqual([{ threadId: "first", status: "stopped", detail: "turn interrupted — the Company connection changed", byHarness: true }]);
});

// Company engines stay attached while their turns end, so a turn's own end
// can reach its requester before the cleanup loop: the cause is noted first.
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

it("queues the parked-computer resume drain only when a parked turn waits behind the release", async () => {
  const quiet = fixture("direct"), quietStop = quiet.stop();
  await quiet.started("first"); quiet.finish("first"); await quietStop;
  expect(quiet.resumeDrains).toEqual([]);
  expect(quiet.microtasks).toEqual([]);

  const f = fixture("direct"), stopping = f.stop();
  f.pendingComputerResumes.set("parked", { threadId: "parked" });
  await f.started("first"); f.finish("first"); await stopping;
  expect(f.owners.has("first")).toBe(false);
  f.flushMicrotasks();
  expect(f.resumeDrains).toEqual([1]);
});

// The parked-resume drain's own semantics (#1651), same extraction technique
// as the cleanup fixture above: which entries survive which drain. The lazy
// park registers its resume before its interrupt lands, so a drain inside
// that settle window sees the thread busy under the parked turn's own
// generation and must keep the entry.
const resumeDrainCode = ts.transpileModule([
  section("/** A turn parked at the computer wait ceiling", "function markComputerResumeFailed("),
  section("function drainComputerResumes(", "type SecretResumeEntry"),
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

function resumeDrainFixture() {
  const dispatched: string[] = [];
  const state = { threadExists: true, busy: false, seatFree: true, latestUser: "u1" };
  const activeInternalGenerationByThread = new Map<string, string>([["t", "g1"]]);
  const context = vm.createContext({
    connectorThread: () => (state.threadExists ? { bot: { id: "b" } } : null),
    store: { activePath: () => [{ role: "user", id: state.latestUser }] },
    threadBusy: () => state.busy,
    turnResources: { free: () => state.seatFree },
    activeInternalGenerationByThread,
    dispatchComputerResume: (entry: { threadId: string }) => { dispatched.push(entry.threadId); },
    queueMicrotask: (run: () => void) => { run(); },
  });
  vm.runInContext(resumeDrainCode, context, { filename: "index.ts (parked resume drain fixture)" });
  return {
    dispatched,
    activeInternalGenerationByThread,
    state,
    register: (overrides: Partial<{ generation: string; afterMessageId: string }> = {}) =>
      context.registerComputerResume({ botId: "b", threadId: "t", resource: "computer:host", generation: "g1", afterMessageId: "u1", ...overrides }),
    drain: () => context.drainComputerResumes(),
  };
}

it("dispatches a parked resume immediately when the seat is already free at registration", () => {
  const f = resumeDrainFixture();
  f.register();
  expect(f.dispatched).toEqual(["t"]);
});

it("keeps a parked resume through its own busy settle window and dispatches on the next drain", () => {
  const f = resumeDrainFixture();
  // The lazy-claim park registers while its turn is still settling: busy
  // under the SAME generation. A drain here must not drop the entry.
  f.state.busy = true;
  f.register();
  f.drain();
  expect(f.dispatched).toEqual([]);
  // The settle lands (turn completes, thread idle); the next drain — its
  // completion, or any later release — continues the parked work.
  f.state.busy = false;
  f.drain();
  expect(f.dispatched).toEqual(["t"]);
});

it("keeps a parked resume while another turn still holds the seat, then dispatches when it frees", () => {
  const f = resumeDrainFixture();
  f.state.seatFree = false;
  f.register();
  f.drain();
  expect(f.dispatched).toEqual([]);
  f.state.seatFree = true;
  f.drain();
  expect(f.dispatched).toEqual(["t"]);
});

it("drops a superseded parked resume when a newer user message arrived", () => {
  const f = resumeDrainFixture();
  f.state.latestUser = "u2";
  f.register();
  f.drain();
  expect(f.dispatched).toEqual([]);
  f.state.latestUser = "u1";
  f.drain();
  expect(f.dispatched).toEqual([]);
});

it("drops a parked resume when a newer generation owns the thread", () => {
  const f = resumeDrainFixture();
  f.activeInternalGenerationByThread.set("t", "g2");
  f.register();
  f.drain();
  expect(f.dispatched).toEqual([]);
  f.activeInternalGenerationByThread.set("t", "g1");
  f.drain();
  expect(f.dispatched).toEqual([]);
});

it("drops a parked resume whose thread no longer exists", () => {
  const f = resumeDrainFixture();
  f.state.threadExists = false;
  f.register();
  f.drain();
  expect(f.dispatched).toEqual([]);
  f.state.threadExists = true;
  f.drain();
  expect(f.dispatched).toEqual([]);
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

// A provider settings save replaces only the engines whose launch config it
// changed (config.ts changedInstanceIds), and interrupts only the turns
// running on them, each requester told why. Saving the same values again, or
// changing another engine's key, leaves a teammate's long turn running.
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
  // Two rooms, each with a member speaking on one of the engines; both
  // members hold a bearer in each from turns they took there.
  const rooms = new Map([["room-compat", { botId: "eli", engine: "compat" }], ["room-claude", { botId: "mira", engine: "claude" }]]);
  const log: string[] = [], settled: Array<{ generation: string; text: string }> = [], revoked: string[] = [];
  const slot = (botId: string) => [`${botId} agents`, { grants: "", token: `t-${botId}` }] as const;
  const bearers = new Map([...threads.map(thread => [thread.threadId, new Map([slot(thread.botId)])] as const),
    ...[...rooms.keys()].map(threadId => [threadId, new Map([slot("eli"), slot("mira")])] as const)]);
  // What each turn in flight was handed.
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
    drainQueuedSends() {}, drainConnectorResumes() {}, drainComputerResumes() {}, drainSecretResumes() {}, drainTeamSetupResumes() {},
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
  // The other engine's processes, bearers and teammate turn are untouched.
  expect(f.log.filter(line => line.includes("claude") || line.includes("mira"))).toEqual([]);
  // Its turns in flight lose what they were handed; every bearer its bot
  // holds goes, in a room too, while the other engine's bot keeps its own
  // even in the room the changed engine's bot was speaking in.
  expect(f.revoked).toEqual(["eli-work", "room-compat"]);
  expect(f.held()).toEqual({
    "eli-work": [], "eli-idle": [], "mira-work": ["mira agents"], "mira-idle": ["mira agents"],
    "room-compat": ["mira agents"], "room-claude": ["mira agents"],
  });
  expect(f.log).toEqual(expect.arrayContaining(["auth:compat", "detach:compat", "cancel:eli-work", "load:compat", "attach:compat",
    "message:eli-work:turn interrupted — provider settings changed",
    "delegation:Delegated turn did not finish — turn interrupted — provider settings changed (eli-work)",
    // a room's assignments fail with the cause, never as the person's Stop
    "room-stop:room-compat:stopped:turn interrupted — provider settings changed:true"]));
  expect(f.settled).toEqual([{ generation: "gen-eli-work", text: "turn interrupted — provider settings changed (eli-work)" }]);
  expect(f.threads.find(thread => thread.threadId === "mira-work")?.busy).toBe(true);
  expect(f.threads.find(thread => thread.threadId === "eli-work")?.busy).toBe(false);
  expect(f.context.providerInstancesChanging.size).toBe(0);
  expect(f.context.providerFleetReloading).toBe(false);
});

// A harness stop ends a room with its cause: the assignments fail with it
// (their assigners read it, not "Stopped by user") and the goal run's card
// says it under the same "stopped" status, so no new failure notice goes out.
it("ends a room stopped by the harness with its cause, and one the person stopped as theirs", () => {
  const run = (outcome?: { status: "stopped"; detail: string; byHarness: true }) => {
    const calls: string[] = [];
    const context = vm.createContext({
      pendingComputerResumes: new Map(), cancelTeamSetupResumesForThread() {},
      roomHandoffs: { cancelRoom: (...args: string[]) => calls.push(`assignments:${args.join("|")}`) },
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
    "goal:stopped|Turn interrupted — provider settings changed.",
  ]);
  expect(run()).toEqual(["assignments:g|room", "goal:stopped|Stopped by you."]);
});
