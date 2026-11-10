import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { cloudHomePlaceRefusal } from "./cloud-home.ts";
import * as boat from "./boat.ts";
import { CLOUD_IDLE_AWAKE_MS, CLOUD_IDLE_WORK_MS, createCloudPower } from "./cloud-power.ts";
import type { CoordinatorHost } from "./coordinator.ts";
import { createCloudComputerPower } from "./host/cloud-computer-power.ts";
import { ManagedDesktopPolicy } from "./managed-policy.ts";
import { RuntimeCoordinator } from "./runtime-coordinator.ts";
import { Runtime } from "./runtime/runtime.ts";
import { openRuntimeStore } from "./runtime/store.ts";
import { chosenPin, resolveSurface } from "./surface.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const worker = { botId: "worker", threadId: "worker-thread" };

function fragment(start: string, end: string): string {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
}

function evaluate(code: string, context: Record<string, unknown>): any {
  return runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText, context);
}

function backgroundValidator(context: Record<string, unknown>): NonNullable<CoordinatorHost["validateBackground"]> {
  return evaluate(`${fragment("\nfunction computerPlaceRefusal(", "\nfunction policyModelRefusal(")}
    const host = { ${fragment("validateBackground: (node, command) => {", "\n    validate:")} }; host.validateBackground;`,
  { CLOUD_HOME: null, cloudHomePlaceRefusal, ...context });
}

function host() {
  return {
    validate: () => undefined, busy: () => false,
    run: vi.fn<CoordinatorHost["run"]>(async () => ({ ok: true, text: "Validated the original command" })),
    report: vi.fn(), park: vi.fn(), changed: vi.fn(),
    names: () => ({ requester: "Person", assignee: "Worker", person: "Person" }),
    levelOf: () => ({ level: "auto" as const }), chiefOf: () => false,
  } satisfies CoordinatorHost;
}

function autoBoat() {
  const bot = { id: worker.botId, name: "Worker", modelSelection: { instanceId: "fake" } };
  const task: { surface?: string; surfaceSource?: "auto" | "user" } = {};
  const store = { bot: () => bot, taskByThread: () => task,
    patchTask: vi.fn((_botId: string, _threadId: string, patch: Partial<typeof task>) => Object.assign(task, patch)) };
  const capture = vi.fn(async () => ({ png: "fixture", format: "png" }));
  const attachBotBoat = vi.fn(async () => ({ boxId: "computer-one", capture }));
  const autoVmClaims = new Map<string, { claim(): Promise<void> }>();
  const adoptClaimedCapture = vi.fn();
  const mounted = evaluate(`
    ${fragment("\nfunction turnSurfacePlan(", "\n/** A query never grants lifecycle authority.")}
    ${fragment("      const autoPinAllowed = () => {", "\n      /** Idempotent per turn;")}
    ${fragment("\nfunction mountBotBoat(", "\nfunction claimedBoatId(")}
    ${fragment('        if (!teamComputer && cloudBackend === "box" && boat.boatConfigured(cfg) && wants === "cloud") {', '\n        if (wants === "cloud" && cloudBackend === "box" && !boat.boatConfigured(cfg)) {')}
    ({ provider: () => turnProvider(bot, undefined, threadId) });`, {
    bot, store, threadId: worker.threadId, resourceOwner: { threadId: worker.threadId, generation: "fixture-turn" },
    teamComputer: undefined, opts: undefined, plan: { pinned: null }, computerSkipped: undefined, ownCloud: { unavailable: false },
    cloudBackend: "box", wants: "cloud", boat: { boatConfigured: () => true }, cfg: {}, placeSource: undefined, handoffOwnCloud: true,
    integrations: {}, autoVmClaims, attachBotBoat, adoptClaimedCapture, cloudComputerTools: () => ({}),
    surfaceLazyClaimRejection: () => vi.fn(), CLOUD_COMPUTER_START_BUDGET_MS: 150_000, CLOUD_COMPUTER_STARTING: "Starting",
    keepTransient: (error: unknown) => error, registry: { get: () => ({ adapter: { capabilities: {} } }) },
    inheritedTeamComputer: () => undefined, proactive: { fence: { confines: () => false } }, botApiThread: () => false,
    resolveSurface, chosenPin, builtInBrowserEnabled: () => false,
  }) as { provider(): string | null };
  return { task, store, attachBotBoat, adoptClaimedCapture, capture, provider: mounted.provider,
    claim: () => autoVmClaims.get(worker.threadId)!.claim() };
}

describe("tracked command production authorization", () => {
  it("retains bot visibility, provider, command ownership and team computer identity checks", () => {
    const managedPolicy = new ManagedDesktopPolicy();
    let bot: { id: string; hidden?: boolean } | undefined = { id: worker.botId };
    let provider: string | null = "box";
    let team: { id: string } | undefined;
    const validateBackground = backgroundValidator({ managedPolicy, store: { bot: () => bot },
      turnProvider: () => provider, inheritedTeamComputer: () => team });
    const coordinator = new RuntimeCoordinator({ dataDir: ":memory:", host: { ...host(), validateBackground } });
    try {
      const node = coordinator.beginTurn({ id: "identity", address: worker, brief: "Run", level: "auto", origin: { kind: "user", request: "Run" } });
      const command = { boxId: "computer-one", processId: "command-one", expiresAt: Date.now() + 60_000 };
      expect(coordinator.trackBackground({ ...worker, botId: "another-bot" }, node.id, command)).toBe(false);
      expect(coordinator.trackBackground({ ...worker, threadId: "another-thread" }, node.id, command)).toBe(false);
      expect(validateBackground(node, command)).toBeUndefined();
      bot.hidden = true; expect(validateBackground(node, command)).toBeDefined();
      bot.hidden = false;
      for (provider of [null, "vps"]) expect(validateBackground(node, command)).toBeDefined();
      provider = "box";
      team = { id: "team-one" }; expect(validateBackground(node, command)).toBeDefined();
      const shared = { ...command, teamComputerId: team.id };
      expect(validateBackground(node, shared)).toBeUndefined();
      team = { id: "team-two" }; expect(validateBackground(node, shared)).toBeDefined();
      team = undefined; expect(validateBackground(node, shared)).toBeDefined();
      bot = undefined; expect(validateBackground(node, command)).toBeDefined();
    } finally { coordinator.close(); managedPolicy.close(); }
  });

  it.each(["before-poll", "in-flight", "before-dispatch"])("enforces effective Cloud policy %s", async phase => {
    const managedPolicy = new ManagedDesktopPolicy();
    const revoke = () => managedPolicy.apply({
      organizationId: "11111111-1111-4111-8111-111111111111", organizationName: "Fixture Agency", expiresAt: Date.now() + 60_000, version: 3,
      companyModelsOnly: false, allowedEngines: "all", mcp: { allowCustom: true, allowlist: [] },
      computers: { thisComputer: true, localVm: true, box: false, vps: true }, remoteAccess: true,
    });
    const validateBackground = backgroundValidator({ managedPolicy, store: { bot: () => ({ id: worker.botId }) },
      turnProvider: () => "box", inheritedTeamComputer: () => undefined });
    let finish!: (result: string) => void;
    const backgroundStatus = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const ports = host();
    const coordinator = new RuntimeCoordinator({ dataDir: ":memory:", host: { ...ports, validateBackground, backgroundStatus } });
    const id = "policy-command";
    const result = '{"status":"finished","exitCode":0,"stdout":"revoked output"}';
    try {
      coordinator.beginTurn({ id, address: worker, brief: "Run and validate", level: "auto", origin: { kind: "user", request: "Run and validate" } });
      expect(coordinator.trackBackground(worker, id, { boxId: "computer-one", processId: "command-one", expiresAt: Date.now() + 60_000 })).toBe(true);
      coordinator.endTurn(id, { ok: true, text: "Running" });
      coordinator.tick();
      if (phase === "before-poll") revoke();
      await flush();
      if (phase === "before-poll") expect(backgroundStatus).not.toHaveBeenCalled();
      else {
        expect(backgroundStatus).toHaveBeenCalledOnce();
        if (phase === "in-flight") revoke();
        finish(result); await flush();
        if (phase === "before-dispatch") expect(coordinator.status(id)?.assignment.backgroundCommands?.[0]?.result).toBe(result);
        revoke();
      }
      if (phase !== "before-dispatch") expect(coordinator.status(id)?.assignment.backgroundCommands?.[0]?.result).toBeUndefined();
      coordinator.tick(); await flush();
      expect(coordinator.node(id)).toMatchObject({ status: "failed", outcome: "refused" });
      expect(ports.run).not.toHaveBeenCalled();
    } finally { coordinator.close(); managedPolicy.close(); }
  });

  it("pins a successful Auto Boat claim so a handed command remains authorized", async () => {
    const mounted = autoBoat();
    expect(mounted.provider()).toBeNull();
    expect(mounted.store.patchTask).not.toHaveBeenCalled();
    await mounted.claim();
    expect(mounted.task).toEqual({ surface: "cloud", surfaceSource: "auto" });
    expect(mounted.provider()).toBe("box");
    expect(mounted.adoptClaimedCapture).toHaveBeenCalledWith(mounted.capture);
    expect(mounted.attachBotBoat.mock.calls[0]).toEqual([expect.anything(), expect.anything(), expect.objectContaining({ existingOnly: true })]);
    const managedPolicy = new ManagedDesktopPolicy();
    const validateBackground = backgroundValidator({ managedPolicy, store: mounted.store, turnProvider: mounted.provider, inheritedTeamComputer: () => undefined });
    const ports = host();
    let finish!: () => void;
    ports.run.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true, text: "Running" }); }));
    const backgroundStatus = vi.fn(async () => '{"status":"finished","exitCode":0,"stdout":"original artifact"}');
    const coordinator = new RuntimeCoordinator({ dataDir: ":memory:", host: { ...ports, validateBackground, backgroundStatus } });
    const chief = { botId: "chief", threadId: "chief-thread" };
    try {
      coordinator.beginTurn({ id: "handoff", address: chief, brief: "Run and validate", level: "auto", origin: { kind: "user", request: "Run and validate" } });
      const { node } = coordinator.enqueue(chief, "handoff", undefined, worker, "Run and validate");
      coordinator.endTurn("handoff", { ok: true, text: "Assigned" }); coordinator.tick();
      expect(coordinator.trackBackground(worker, node.id, { boxId: "computer-one", processId: "command-one", expiresAt: Date.now() + 60_000 })).toBe(true);
      finish(); await flush(); coordinator.tick(); await flush(); coordinator.tick(); await flush();
      expect(coordinator.node(node.id)).toMatchObject({ status: "completed", executions: 2 });
      expect(ports.run.mock.calls.filter(([run]) => run.id === node.id)).toHaveLength(2);
      expect(backgroundStatus).toHaveBeenCalledOnce();
    } finally { coordinator.close(); managedPolicy.close(); }
  });

  it("leaves a denied Auto Boat claim unpinned", async () => {
    const mounted = autoBoat();
    mounted.attachBotBoat.mockRejectedValueOnce(new Error("Computer access was removed"));
    await expect(mounted.claim()).rejects.toThrow("Computer access was removed");
    expect(mounted.task).toEqual({});
    expect(mounted.provider()).toBeNull();
    expect(mounted.store.patchTask).not.toHaveBeenCalled();
    expect(mounted.adoptClaimedCapture).not.toHaveBeenCalled();
  });

  it.each(["terminal", "expired"])("blocks Cloud home sleep after restart and inventory failure until a command is %s", async completion => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-background-power-"));
    let now = Date.now();
    const seed = openRuntimeStore(join(dataDir, "runtime.db"));
    const ports = host();
    const runtime = new Runtime(seed, { ...ports, canStart: () => true, run: async () => ({ kind: "completed", text: "Validated" }) },
      { clock: { now: () => now, monotonic: () => now } });
    const id = "pending-command";
    try {
      runtime.begin({ id, origin: { kind: "person", source: "chat", quote: "Run and validate" }, requester: { kind: "person", threadId: worker.threadId },
        assignee: { botId: worker.botId, destination: { kind: "standing_thread", threadId: worker.threadId } }, brief: "Run and validate", level: "auto" });
      expect(runtime.trackBackground(id, { boxId: "computer-one", processId: "command-one", expiresAt: now + 5 * 60_000 })).toBe(true);
      runtime.end(id, { ok: true, text: "Running" });
      expect(runtime.pace()).toBe("parked");
    } finally { runtime.close(); seed.close(); }
    const backgroundStatus = vi.fn(async () => '{"status":"finished","exitCode":0}');
    const coordinator = new RuntimeCoordinator({ dataDir, now: () => now, host: { ...ports, backgroundStatus } });
    const inventory = vi.spyOn(boat, "listManagedBoats").mockRejectedValue(new Error("Fixture inventory unavailable"));
    const computerPower = createCloudComputerPower({ cfg: { box: { token: "box_test" } }, busy: () => false, claim: () => () => {},
      owners: () => [], routines: () => [], routineComputer: () => null, broadcast: () => {}, log: () => {} });
    const context = { cloudComputerPower: computerPower, boatLifecycleBusyBots: new Set(), coordinator };
    const computer = evaluate(`(${fragment("computer: () => cloudComputerPower.awake()", ", nextDueAt:").slice("computer: ".length)})`, context) as () => boolean;
    const handoff = evaluate(`(${fragment("handoff: () => coordinator.pace()", ",\n  liveCall:").slice("handoff: ".length)})`, context) as () => boolean;
    const home = createCloudPower({ dataDir, now: () => now, broadcast: () => {}, probes: {
      turn: () => false, run: () => false, handoff, liveCall: () => false, computer, maintenance: () => false, nextDueAt: () => null,
    } });
    const pass = (ms: number) => { for (let left = ms; left > 0; left -= 5_000) { now += Math.min(5_000, left); home.tick(); } };
    try {
      await computerPower.armRunning();
      expect(inventory).toHaveBeenCalledOnce();
      expect(computerPower.awake()).toBe(false);
      expect(coordinator.pace()).toBe("parked");
      expect(coordinator.status(id)?.assignment.backgroundCommands?.[0]).toMatchObject({ processId: "command-one" });
      expect(coordinator.status(id)?.assignment.backgroundCommands?.[0]?.delivered).toBeUndefined();
      pass(CLOUD_IDLE_AWAKE_MS);
      expect(home.report()).toMatchObject({ idle: false, busy: ["computer"] });
      expect(home.prepareSleep()).toEqual({ ok: false, busy: ["computer"] });
      if (completion === "expired") pass(3 * 60_000);
      coordinator.tick(); await flush();
      expect(home.prepareSleep()).toEqual({ ok: false, busy: ["computer"] });
      coordinator.tick(); await flush();
      expect(coordinator.node(id)).toMatchObject({ status: "completed", executions: 2 });
      expect(ports.run).toHaveBeenCalledOnce();
      expect(coordinator.status(id)?.assignment.backgroundCommands?.[0]).toMatchObject({ delivered: true });
      if (completion === "expired") {
        expect(backgroundStatus).not.toHaveBeenCalled();
        expect(coordinator.status(id)?.assignment.backgroundCommands?.[0]?.result).toContain('"status":"unknown"');
      } else expect(backgroundStatus).toHaveBeenCalledOnce();
      expect(home.prepareSleep()).toEqual({ ok: false, busy: ["recent-work"] });
      pass(CLOUD_IDLE_WORK_MS);
      expect(home.prepareSleep()).toEqual({ ok: true, nextDueAt: null });
    } finally { home.close(); computerPower.close(); coordinator.close(); inventory.mockRestore(); await removeTempDir(dataDir); }
  });
});
