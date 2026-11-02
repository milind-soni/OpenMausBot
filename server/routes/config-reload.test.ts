import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import vm from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { changedInstanceIds, engineLaunches, instanceConfigs, loadConfig, saveConfig, syncCredentialEnv } from "../config.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import { ProviderTurnGenerationRegistry } from "../turn-dispatch-guard.ts";
import { stoppedTurnOutcome, TurnStops } from "../turn-outcome.ts";
import { EventBus } from "../harness/bus.ts";
import { reloadProviderInstances } from "../harness/provider-reload.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { resetPathCache } from "../env-path.ts";
import { createInstanceRoutes, type InstanceRouteDeps } from "./instances.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./config.ts";

const source = ts.createSourceFile("index.ts", readFileSync(new URL("../index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest);
const reload = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "reloadProviders");
if (!reload) throw new Error("Provider reload function not found");
const reloadCode = ts.transpileModule(reload.getText(source), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

let pendingReload: ts.Expression | undefined;
const findPendingReload = (node: ts.Node): void => {
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === "hasPendingProviderReload") pendingReload = node.initializer;
  ts.forEachChild(node, findPendingReload);
};
findPendingReload(source);
if (!pendingReload) throw new Error("Pending provider reload predicate not found");
const pendingCode = ts.transpileModule(`globalThis.hasPendingProviderReload = ${pendingReload.getText(source)}`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext },
}).outputText;

it.each(["PATCH", "PUT"])("%s /api/config retries identical saved settings until the retiring owner can be replaced", async (method) => {
  syncCredentialEnv({ openaiCompat: { key: "synthetic-old-key" } });
  saveConfig({ openaiCompat: { key: "synthetic-old-key" } });
  const cfg = loadConfig();
  const providerConfigs = () => ({
    compat: { driver: "openai-compat", environment: { OPENAI_COMPAT_API_KEY: cfg.openaiCompat!.key! } },
  });
  const fake = makeFakeDriver({ kind: "openai-compat" });
  const registry = new ProviderRegistry([fake.driver]);
  await registry.load(providerConfigs());
  const old = registry.get("compat")!;
  const blocked = new Error("synthetic teardown blocked: old CLI still running");
  const dispose = vi.spyOn(old, "dispose").mockRejectedValue(blocked);
  const create = vi.spyOn(fake.driver, "create");
  const bus = new EventBus();
  bus.attach([old]);
  const providerInstancesChanging = new Set<string>();
  const context = vm.createContext({
    providerConfigs, registry, bus, reloadProviderInstances, changedInstanceIds, engineLaunches,
    providerInstancesChanging, pendingProviderReloads: new Set<string>(), providerFleetReloading: false,
    store: { bots: [] }, groupSpeakers: new Map(),
    decorateHostedProvider: undefined,
    revokeEngineCapabilities() {}, providerAuthSessions: { clearInstance() {} }, drainQueuedSends() {},
  });
  vm.runInContext(reloadCode + pendingCode, context);
  let busy = false;
  let attempts = 0;
  const route = createConfigRoutes({
    cfg, registry, store: { bots: [] }, hostedModels: false, cloudHome: false,
    lendingEnabled: () => true, providerConfigs,
    providerConfigBusy: { get: () => busy, set: (value: boolean) => { busy = value; } },
    computerProviderConfigTransitions: new Set(),
    configStatus: () => ({ saved: true }), configForAccess: (status: unknown) => status,
    broadcast() {}, revokeEngineCapabilities() {},
    hasPendingProviderReload: () => context.hasPendingProviderReload(),
    reloadProviders: async (before: Record<string, unknown>) => {
      attempts++;
      await context.reloadProviders(before);
    },
  } as unknown as ConfigRouteDeps);
  const send = async () => {
    let response: { status: number; body: unknown } | undefined;
    try {
      await route({
        method, path: "/api/config", url: new URL("http://fixture/api/config"),
        req: { headers: {} } as IncomingMessage, res: {} as ServerResponse,
        auth: { kind: "loopback", scopes: ["admin"] },
        readBody: async () => ({ openaiCompat: { key: "synthetic-new-key" } }),
        json: (_res, status, body) => { response = { status, body }; },
      });
      return { response, error: undefined };
    } catch (error) {
      return { response, error };
    }
  };
  try {
    expect(await send()).toEqual({ response: undefined, error: blocked });
    expect(loadConfig().openaiCompat?.key).toBe("synthetic-new-key");
    expect(registry.get("compat")).toBe(old);
    expect(registry.retiringIds()).toEqual(["compat"]);
    expect([...providerInstancesChanging]).toEqual(["compat"]);
    expect(busy).toBe(false);

    expect.soft(await send()).toEqual({ response: undefined, error: blocked });
    expect.soft(attempts).toBe(2);
    expect(registry.get("compat")).toBe(old);
    expect(registry.retiringIds()).toEqual(["compat"]);
    expect([...providerInstancesChanging]).toEqual(["compat"]);
    expect(create).not.toHaveBeenCalled();
    expect(busy).toBe(false);

    dispose.mockResolvedValue();
    expect(await send()).toEqual({ response: { status: 200, body: { saved: true } }, error: undefined });
    expect.soft(attempts).toBe(3);
    expect.soft(registry.get("compat")).not.toBe(old);
    expect.soft(registry.retiringIds()).toEqual([]);
    expect.soft([...providerInstancesChanging]).toEqual([]);
    expect.soft(create).toHaveBeenCalledTimes(1);
    expect.soft(create.mock.calls[0]?.[0].environment.OPENAI_COMPAT_API_KEY).toBe("synthetic-new-key");
    expect(busy).toBe(false);

    expect(await send()).toEqual({ response: { status: 200, body: { saved: true } }, error: undefined });
    expect.soft(attempts).toBe(3);
    expect.soft(create).toHaveBeenCalledTimes(1);
  } finally {
    dispose.mockResolvedValue();
    bus.detach("compat");
    await registry.disposeAll();
    vi.restoreAllMocks();
  }
});

it.each(["managed-desktop", "cloud-credit"])("config reload preserves a retiring %s owner outside saved settings", async (instanceId) => {
  const configs = { compat: { driver: "openai-compat", environment: { OPENAI_COMPAT_API_KEY: "new-key" } } };
  const before = engineLaunches({ compat: { driver: "openai-compat", environment: { OPENAI_COMPAT_API_KEY: "old-key" } } });
  const fake = makeFakeDriver({ kind: "openai-compat" });
  const registry = new ProviderRegistry([fake.driver]);
  await registry.load({ ...configs, [instanceId]: { driver: "openai-compat" } });
  const managed = registry.get(instanceId)!;
  const dispose = vi.spyOn(managed, "dispose").mockRejectedValue(new Error("synthetic managed teardown blocked"));
  const bus = new EventBus();
  bus.attach(registry.instances());
  const context = vm.createContext({
    providerConfigs: () => configs, registry, bus, reloadProviderInstances, changedInstanceIds, engineLaunches,
    providerInstancesChanging: new Set<string>(), pendingProviderReloads: new Set<string>(), providerFleetReloading: false,
    store: { bots: [] }, groupSpeakers: new Map(), decorateHostedProvider: undefined,
    revokeEngineCapabilities() {}, providerAuthSessions: { clearInstance() {} }, drainQueuedSends() {},
  });
  vm.runInContext(reloadCode + pendingCode, context);
  try {
    await expect(registry.dispose(instanceId)).rejects.toThrow("synthetic managed teardown blocked");
    dispose.mockResolvedValue();
    expect.soft(context.hasPendingProviderReload()).toBe(false);
    await context.reloadProviders(before);
    expect.soft(registry.get(instanceId)).toBe(managed);
    expect.soft(registry.retiringIds()).toEqual([instanceId]);
    expect.soft(dispose).toHaveBeenCalledTimes(1);
  } finally {
    dispose.mockResolvedValue();
    bus.detachAll();
    await registry.disposeAll();
    vi.restoreAllMocks();
  }
});

it("config reload retries failed disposal of a removed saved instance", async () => {
  const before = engineLaunches({ removed: { driver: "openai-compat" } });
  const fake = makeFakeDriver({ kind: "openai-compat" });
  const registry = new ProviderRegistry([fake.driver]);
  await registry.load({ removed: { driver: "openai-compat" } });
  const old = registry.get("removed")!;
  const dispose = vi.spyOn(old, "dispose").mockRejectedValue(new Error("synthetic removed teardown blocked"));
  const context = vm.createContext({
    providerConfigs: () => ({}), registry, bus: new EventBus(), reloadProviderInstances, changedInstanceIds, engineLaunches,
    providerInstancesChanging: new Set<string>(), pendingProviderReloads: new Set<string>(), providerFleetReloading: false,
    store: { bots: [] }, groupSpeakers: new Map(), decorateHostedProvider: undefined,
    revokeEngineCapabilities() {}, providerAuthSessions: { clearInstance() {} }, drainQueuedSends() {},
  });
  vm.runInContext(reloadCode + pendingCode, context);
  try {
    await expect(context.reloadProviders(before)).rejects.toThrow("synthetic removed teardown blocked");
    expect(registry.retiringIds()).toEqual(["removed"]);
    expect(context.hasPendingProviderReload()).toBe(true);
    await expect(context.reloadProviders({})).rejects.toThrow("synthetic removed teardown blocked");
    dispose.mockResolvedValue();
    await context.reloadProviders({});
    expect(context.hasPendingProviderReload()).toBe(false);
    expect(registry.get("removed")).toBeNull();
    expect(registry.retiringIds()).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(3);
  } finally {
    dispose.mockResolvedValue();
    await registry.disposeAll();
    vi.restoreAllMocks();
  }
});

it("instance PATCH clears only its successful pending config reload and preserves failures", async () => {
  const cfg = { instances: {
    compat: { driver: "openai-compat", config: { tools: true } },
    other: { driver: "openai-compat", config: { tools: true } },
  } };
  const providerConfigs = () => instanceConfigs(cfg);
  const before = structuredClone(engineLaunches(providerConfigs()));
  const fake = makeFakeDriver({ kind: "openai-compat" });
  const registry = new ProviderRegistry([fake.driver]);
  await registry.load(providerConfigs());
  const old = registry.get("compat")!;
  const dispose = vi.spyOn(old, "dispose").mockRejectedValue(new Error("synthetic teardown blocked"));
  const create = vi.spyOn(fake.driver, "create");
  const context = vm.createContext({
    cfg, saveConfig, instanceConfigs, resetPathCache,
    providerConfigs, registry, bus: new EventBus(), reloadProviderInstances, changedInstanceIds, engineLaunches,
    providerInstancesChanging: new Set<string>(), pendingProviderReloads: new Set<string>(), providerFleetReloading: false,
    store: { bots: [] }, groupSpeakers: new Map(), decorateHostedProvider: undefined,
    revokeEngineCapabilities() {}, providerAuthSessions: { clearInstance() {} }, drainQueuedSends() {},
  });
  const persist = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "persistProviderInstance");
  if (!persist) throw new Error("Instance persistence function not found");
  vm.runInContext(reloadCode + pendingCode + ts.transpileModule(persist.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText, context);
  const route = createInstanceRoutes({
    cfg, registry, store: { bots: [] }, hostedModels: false,
    providerConfigBusy: { get: () => false, set() {} },
    providerInstancesChanging: context.providerInstancesChanging,
    persistProviderInstance: (id: string, instances: InstanceConfigMap) => context.persistProviderInstance(id, instances),
    describeInstances: async () => [],
  } as unknown as InstanceRouteDeps);
  const patch = () => route({
    method: "PATCH", path: "/api/instances/compat", url: new URL("http://fixture/api/instances/compat"),
    req: { headers: { "content-type": "application/json" } } as IncomingMessage, res: {} as ServerResponse,
    auth: { kind: "loopback", scopes: ["admin"] }, readBody: async () => ({ tools: false }),
    json: (_res, status) => { expect(status).toBe(200); },
  });
  try {
    cfg.instances.compat.config.tools = false;
    await expect(context.reloadProviders(before)).rejects.toThrow("synthetic teardown blocked");
    expect(context.hasPendingProviderReload()).toBe(true);
    expect([...context.pendingProviderReloads]).toEqual(["compat"]);
    await expect(patch()).rejects.toThrow("synthetic teardown blocked");
    expect([...context.pendingProviderReloads]).toEqual(["compat"]);
    dispose.mockResolvedValue();
    context.pendingProviderReloads.add("other");
    await patch();
    const replacement = registry.get("compat");
    expect(replacement).not.toBe(old);
    expect.soft([...context.pendingProviderReloads]).toEqual(["other"]);
    expect(create).toHaveBeenCalledTimes(1);
    await context.reloadProviders(engineLaunches(providerConfigs()));
    expect.soft(registry.get("compat")).toBe(replacement);
    expect.soft(create).toHaveBeenCalledTimes(2);
    expect(context.hasPendingProviderReload()).toBe(false);
    await context.reloadProviders(engineLaunches(providerConfigs()));
    expect.soft(create).toHaveBeenCalledTimes(2);
  } finally {
    dispose.mockResolvedValue();
    await registry.disposeAll();
    vi.restoreAllMocks();
  }
});

it.each([
  { name: "preserves its cause when disposal completes the interrupted turn", when: "none", rejects: false, stopReason: "interrupted", expected: "Turn interrupted — provider settings changed" },
  { name: "preserves an independent error before reload", when: "before", rejects: false, stopReason: "error", expected: "Authentication failed: API key expired" },
  { name: "preserves an independent error during disposal", when: "during", rejects: false, stopReason: "error", expected: "Authentication failed: API key expired" },
  { name: "preserves an independent error after rejected disposal", when: "after", rejects: true, stopReason: "error", expected: "Authentication failed: API key expired" },
  { name: "preserves an error even when the terminal reason is interrupted", when: "during", rejects: false, stopReason: "interrupted", expected: "Authentication failed: API key expired" },
  { name: "restores an earlier stop cause after rejected disposal", when: "stopping", rejects: true, stopReason: "interrupted", expected: "Stopped by the original request" },
  { name: "preserves an independent terminal reason", when: "none", rejects: false, stopReason: "max_tokens", expected: "The turn did not complete (max_tokens)" },
  { name: "removes a rejected reload cause before a later interruption", when: "none", rejects: true, stopReason: "interrupted", expected: "The turn did not complete (interrupted)" },
])("provider reload $name", async ({ when, rejects, stopReason, expected }) => {
  const configs = { compat: { driver: "openai-compat", environment: { OPENAI_COMPAT_API_KEY: "new-key" } } };
  const before = engineLaunches({ compat: { driver: "openai-compat", environment: { OPENAI_COMPAT_API_KEY: "old-key" } } });
  const fake = makeFakeDriver({ kind: "openai-compat" });
  const registry = new ProviderRegistry([fake.driver]);
  await registry.load(configs);
  const old = registry.get("compat")!;
  const emit = fake.created.get("compat")!.emit;
  const bus = new EventBus(async () => {});
  bus.attach([old]);
  const turnStops = new TurnStops();
  const turnId = "reload-turn";
  const threadId = "reload-thread";
  const generation = "reload-generation";
  const owner = { generation };
  const outcomes: Array<{ ok: boolean; text: string }> = [];
  const directFollowupTurns = new ProviderTurnGenerationRegistry<{ ok: boolean; text: string }>();
  directFollowupTurns.bind(threadId, generation, turnId);
  let enterDisposal!: () => void;
  const disposing = new Promise<void>(resolve => { enterDisposal = resolve; });
  let endCli!: () => void;
  const cliEnded = new Promise<void>(resolve => { endCli = resolve; });
  const dispose = vi.spyOn(old, "dispose").mockImplementation(async () => {
    enterDisposal();
    await cliEnded;
    if (rejects) throw new Error("synthetic teardown blocked");
    complete();
  });
  const complete = () => emit({ eventId: "reload-completed", createdAt: "2026-10-29T00:00:00.000Z", type: "turn.completed", provider: "openai-compat", threadId, turnId, ok: false, stopReason });
  const releaseTurnResources = vi.fn();
  const store = {
    bots: [{ id: "helper" }],
    tasks: () => [{ threadId }],
    botByThread: () => ({ id: "helper" }),
    messagesFor: () => [], activePath: () => [],
    taskByThread: () => ({ threadId }), appendMessage() {}, setTaskActivity() {},
  };
  const context = vm.createContext({
    providerConfigs: () => configs, registry, bus, reloadProviderInstances, changedInstanceIds, engineLaunches,
    providerInstancesChanging: new Set<string>(), pendingProviderReloads: new Set<string>(), providerFleetReloading: false,
    store, groupSpeakers: new Map(), decorateHostedProvider: undefined,
    threadBusy: () => true, threadEngineId: () => "compat",
    turnResourceOwners: new Map([[threadId, owner]]), liveTurnByThread: new Map([[threadId, turnId]]),
    turnStops, stoppedTurnOutcome, directFollowupTurns,
    shouldIgnoreProviderEvent: () => false,
    watchdog: { settle() {}, observe() {} }, coordinator: { progress() {} }, revokeInternalCapabilityForProviderEvent() {},
    unansweredApprovals: { annotate: (_threadId: string, _turnId: string, text: string) => text },
    settleDirectCoordination: (_generation: string, outcome: { ok: boolean; text: string }) => { outcomes.push(outcome); },
    settleDirectFollowup: (_generation: string, outcome?: { ok: boolean; text: string }) => {
      if (outcome && !outcomes.length) outcomes.push(outcome);
    },
    cancelDirectTurnDispatch() {}, revokeEngineCapabilities() {}, providerAuthSessions: { clearInstance() {} },
    stopScreenPoller() {}, releaseLocalVmThread() {}, releaseTurnResources, endForeignTurns() {}, vpsThreadEnded() {},
    closeOpenApprovals() {}, directTurnBots: new Map(), runningTurnEngines: new Map(), routines: undefined,
    failedTurnTool: (name: string) => ({ name, ok: false }), drainQueuedSends() {},
  });
  const stoppedText = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "stoppedTurnText");
  const terminalSubscriber = source.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "bus.subscribe"
    && node.getText(source).includes("turnStops.note(event)"));
  if (!stoppedText || !terminalSubscriber) throw new Error("Turn outcome consumer not found");
  vm.runInContext(reloadCode + ts.transpileModule(stoppedText.getText(source) + "\n" + terminalSubscriber.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText, context);
  const fail = () => emit({ eventId: "independent-error", createdAt: "2026-10-29T00:00:00.000Z", type: "runtime.error", provider: "openai-compat", threadId, turnId, message: "Authentication failed: API key expired" });
  if (when === "stopping") turnStops.stopping(threadId, turnId, "stopped by the original request");
  if (when === "before") fail();
  const reloading = context.reloadProviders(before);
  try {
    await disposing;
    expect(outcomes).toEqual([]);
    expect(releaseTurnResources).not.toHaveBeenCalled();
    expect(registry.get("compat")).toBe(old);
    if (when === "during") fail();
    endCli();
    if (rejects) {
      await expect(reloading).rejects.toThrow("synthetic teardown blocked");
      expect.soft(turnStops.read(threadId, turnId)?.cause).toBe(when === "stopping" ? "stopped by the original request" : undefined);
      expect(outcomes).toEqual([]);
      expect(registry.get("compat")).toBe(old);
      expect(releaseTurnResources).not.toHaveBeenCalled();
      if (when === "after") fail();
      complete();
    } else await reloading;
    expect(outcomes).toEqual([{
      ok: false,
      text: expected + ". No tool calls were seen before it stopped.",
    }]);
    if (rejects) {
      expect(registry.get("compat")).toBe(old);
      expect(releaseTurnResources).not.toHaveBeenCalled();
    } else {
      expect(registry.get("compat")).not.toBe(old);
      expect(releaseTurnResources).toHaveBeenCalledWith(owner);
    }
  } finally {
    endCli();
    await reloading.catch(() => {});
    dispose.mockResolvedValue();
    bus.detachAll();
    await bus.flush();
    await registry.disposeAll();
    vi.restoreAllMocks();
  }
});
