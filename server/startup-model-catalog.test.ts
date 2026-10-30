import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelCatalog, ProviderDriver, ProviderInstance, SendTurnInput } from "./contracts.ts";
import { createAcpDriver, type AcpSupport } from "./drivers/acp/core.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import * as procs from "./procs.ts";
import { holdUntilFirstEngineRead } from "./first-engine-read.ts";
import { openStartupModelCatalog, writeStartupModelCache } from "./startup-model-catalog.ts";

const CACHED: ModelCatalog = {
  default: "cached-model",
  options: [{ id: "cached-model", label: "Cached" }],
};
const FRESH: ModelCatalog = {
  default: "fresh-model",
  options: [{ id: "fresh-model", label: "Fresh" }],
};

function seedBots(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify([{ id: "bot-1" }]));
}

function deferredCatalog(): { promise: Promise<ModelCatalog>; release: (catalog: ModelCatalog) => void } {
  let release: (catalog: ModelCatalog) => void = () => {};
  const promise = new Promise<ModelCatalog>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function slowDriver(gate: Promise<ModelCatalog>): {
  driver: ProviderDriver<Record<string, unknown>>;
  seenByTurn: () => ModelCatalog | null;
} {
  let seen: ModelCatalog | null = null;
  const driver: ProviderDriver<Record<string, unknown>> = {
    driverKind: "slow-catalog",
    metadata: { displayName: "Slow catalog" },
    models: { default: "static-model", options: [{ id: "static-model", label: "Static" }] },
    decodeConfig: (raw) => (raw ?? {}) as Record<string, unknown>,
    defaultConfig: () => ({}),
    async create(input): Promise<ProviderInstance> {
      let models = driver.models;
      const opened = await openStartupModelCatalog({
        instanceId: input.instanceId,
        use: (catalog) => { models = catalog; },
        current: () => models,
        refresh: async () => { models = await gate; },
      });
      const startupModelRefresh = opened?.pending;
      return {
        instanceId: input.instanceId,
        driverKind: "slow-catalog",
        displayName: input.displayName,
        enabled: input.enabled,
        get models() { return models; },
        ...(startupModelRefresh ? { startupModelRefresh } : {}),
        snapshot: async () => ({ state: "available", version: "0" }),
        adapter: {
          provider: "slow-catalog",
          capabilities: { sessionModelSwitch: "unsupported" },
          sendTurn: async () => {
            if (startupModelRefresh) await startupModelRefresh;
            seen = models;
            return { turnId: "turn-1" };
          },
          interruptTurn: async () => {},
          respondToRequest: async () => "unavailable" as const,
          hasSession: () => false,
          stopAll: async () => {},
          onEvent: () => () => {},
        },
        dispose: async () => {},
      };
    },
  };
  return { driver, seenByTurn: () => seen };
}

const acpSupport = (resolveModels: () => Promise<ModelCatalog>): AcpSupport => ({
  driverKind: "startup-catalog-test",
  displayName: "Startup catalog",
  models: { default: "static-model", options: [{ id: "static-model", label: "Static" }] },
  defaultCli: "startup-catalog-test",
  nativeSource: "startup-catalog-test.acp",
  loginNote: "not signed in",
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  resolveModels,
});

async function settledSoon(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  // create() and registry.load() queue a few already-resolved awaits; a refresh still on the gate never settles inside this drain.
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  return settled;
}

describe("startup model catalogs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(join(DATA_DIR, "bots.json"), { force: true });
    rmSync(join(DATA_DIR, "providers", "engine-models"), { recursive: true, force: true });
  });

  it("does not wait for a slow refresh when a later start already has a catalog", async () => {
    seedBots();
    writeStartupModelCache("slow", CACHED);
    const gate = deferredCatalog();
    const { driver } = slowDriver(gate.promise);
    const registry = new ProviderRegistry([driver]);
    const loading = registry.load({ slow: { driver: "slow-catalog" } });
    expect(await settledSoon(loading)).toBe(true);
    await loading;
    expect(registry.get("slow")!.models).toEqual(CACHED);
    expect(registry.get("slow")!.startupModelRefresh).toEqual(expect.any(Promise));
    gate.release(FRESH);
    await registry.get("slow")!.startupModelRefresh;
    expect(registry.get("slow")!.models).toEqual(FRESH);
  });

  it("holds a later start's refresh behind the first engine read only while a saved list stands in, and a first run's never", async () => {
    seedBots();
    let refreshes = 0;
    const open = (instanceId = "held") => openStartupModelCatalog({ instanceId, use: () => {}, current: () => CACHED, refresh: async () => { refreshes += 1; } });
    writeStartupModelCache("held", CACHED);
    const release = holdUntilFirstEngineRead();
    const opened = open() as { pending: Promise<void> };
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    expect(refreshes).toBe(0);
    await (open("nothing-saved") as { pending: Promise<void> }).pending;
    expect(refreshes).toBe(1);
    refreshes = 0;
    release();
    await opened.pending;
    expect(refreshes).toBe(1);
    await (open() as { pending: Promise<void> }).pending;
    expect(refreshes).toBe(2);

    rmSync(join(DATA_DIR, "bots.json"), { force: true });
    const releaseAgain = holdUntilFirstEngineRead();
    await open();
    expect(refreshes).toBe(3);
    releaseAgain();
  });

  it("still waits for discovery on the first run, when nothing is cached", async () => {
    const gate = deferredCatalog();
    const { driver } = slowDriver(gate.promise);
    const registry = new ProviderRegistry([driver]);
    const loading = registry.load({ slow: { driver: "slow-catalog" } });
    expect(await settledSoon(loading)).toBe(false);
    gate.release(FRESH);
    await loading;
    expect(registry.get("slow")!.models).toEqual(FRESH);
    expect(registry.get("slow")!.startupModelRefresh).toBeUndefined();
  });

  it("a turn waits for the in-flight refresh instead of the saved catalog", async () => {
    seedBots();
    writeStartupModelCache("slow", CACHED);
    const gate = deferredCatalog();
    const { driver, seenByTurn } = slowDriver(gate.promise);
    const registry = new ProviderRegistry([driver]);
    await registry.load({ slow: { driver: "slow-catalog" } });
    const instance = registry.get("slow")!;
    let finished = false;
    const turn = instance.adapter.sendTurn({ threadId: "thread-1", text: "hello" } satisfies SendTurnInput)
      .then(() => { finished = true; });
    expect(await settledSoon(turn)).toBe(false);
    expect(seenByTurn()).toBeNull();
    gate.release(FRESH);
    await turn;
    expect(finished).toBe(true);
    expect(seenByTurn()).toEqual(FRESH);
  });

  it("an ACP engine serves a saved catalog and lets the turn wait for the refresh", async () => {
    seedBots();
    writeStartupModelCache("cursor", CACHED);
    const gate = deferredCatalog();
    const spawn = vi.spyOn(procs, "spawnCli").mockImplementation(() => {
      throw new Error("spawned");
    });
    const driver = createAcpDriver(acpSupport(() => gate.promise));
    const creating = driver.create({
      instanceId: "cursor",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: driver.defaultConfig(),
    });
    expect(await settledSoon(creating)).toBe(true);
    const instance = await creating;
    expect(instance.models).toEqual(CACHED);
    const turn = instance.adapter.sendTurn({ threadId: "thread-1", text: "hello", cwd: DATA_DIR });
    expect(await settledSoon(turn)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    gate.release(FRESH);
    await expect(turn).rejects.toThrow("spawned");
    expect(instance.models).toEqual(FRESH);
    expect(spawn).toHaveBeenCalled();
    await instance.dispose();
  });
});
