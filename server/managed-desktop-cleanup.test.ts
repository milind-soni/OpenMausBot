import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

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
  section("async function reloadProviders()", "// Config writes rebuild the whole provider registry."),
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
    providerFleetReloading: false, companyShutdown: false, providerInstancesChanging: new Set(),
    providerAuthSessions: { clearInstance() {} }, bus: { detach: (id: string) => detached.push(id) },
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
    roomHandoffs: { stopAwaitingDirect() {} }, noteTeammatesLeftRunning() {},
    cancelDirectTurnDispatch: (_botId: string, threadId: string) => cancelled.push(threadId),
    cancelGroupTurnOperations: (_groupId: string, threadId: string) => cancelled.push(threadId),
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
    autoVmClaims,
    interruptCalls, cancelled, revoked, messages, settled, detached,
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
  f.context.companyShutdown = true;
  await f.stop();
  expect(f.interruptCalls).toEqual([]);
  expect(f.messages).toEqual([]);
  expect(f.detached).toEqual(["company"]);
  expect(f.tasks.get("first")?.busy).toBe(true);
});

it("reattaches rebuilt personal providers before a Company restore failure", async () => {
  const order: string[] = [];
  const personal = { instanceId: "personal" };
  const context = vm.createContext({
    providerFleetReloading: false,
    providerAuthSessions: { clear: () => order.push("clear-auth") },
    revokeAllInternalCapabilities: () => order.push("revoke-capabilities"),
    store: { bots: [] },
    groupSpeakers: new Map(),
    bus: {
      detachAll: () => order.push("detach"),
      attach: (instances: Array<{ instanceId: string }>) => order.push(`attach:${instances.map(instance => instance.instanceId).join(",")}`),
    },
    registry: {
      disposeAll: async () => { order.push("dispose"); },
      load: async () => { order.push("load-personal"); },
      instances: () => [personal],
    },
    providerConfigs: () => ({ personal: { driver: "fake" } }), decorateHostedProvider: undefined,
    managedDesktop: { restore: async () => { order.push("restore-company"); throw new Error("Fixture Company restore failure"); } },
  });
  vm.runInContext(reloadProvidersCode, context, { filename: "index.ts (provider reload fixture)" });

  await expect(context.reloadProviders()).rejects.toThrow("Fixture Company restore failure");
  expect(order).toEqual([
    "clear-auth", "revoke-capabilities", "detach", "dispose", "load-personal", "attach:personal", "restore-company",
  ]);
  expect(context.providerFleetReloading).toBe(false);
});
