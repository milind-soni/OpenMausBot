import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import type { ModelCatalog, ProviderInstance } from "../../contracts.ts";
import { DATA_DIR } from "../../config.ts";
import { writeStartupModelCache } from "../../startup-model-catalog.ts";
import { createLimitTakeover } from "../../host/limit-takeover.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { createOpenCodeDriver, openCodeLimitFacts, parseOpenCodeModelsOutput, resetOpenCodeModelCache } from "./opencode-go.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
const REFUSED = "opencode/refused-free";
const OTHER = "opencode/other";
const MESSAGE = "FreeUsageLimitError: free models are limited today";
const dirs: string[] = [];
const instances: ProviderInstance[] = [];
let restoreBots: (() => void) | undefined;
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
  resetOpenCodeModelCache();
  restoreBots?.();
  restoreBots = undefined;
});

function savedListing(instanceId: string, checkedAt = Date.now()) {
  const file = join(DATA_DIR, "bots.json");
  const previous = existsSync(file) ? readFileSync(file) : null;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify([{ id: "fixture" }]));
  restoreBots = () => { if (previous) writeFileSync(file, previous); else rmSync(file, { force: true }); };
  writeStartupModelCache(instanceId, prices("free"), { checkedAt });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

async function otherHeld(instance: ProviderInstance, dir: string) {
  const recorder = recordEvents(instance.adapter);
  try {
    const { turnId } = await instance.adapter.sendTurn({ threadId: instance.instanceId, text: "hello", model: REFUSED });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const error = recorder.events.find((event) => event.type === "runtime.error" && event.turnId === turnId);
    expect(error).toMatchObject({ type: "runtime.error", limit: "model" });
    const takeover = createLimitTakeover({
      file: join(dir, "notices.json"), engines: () => [], configs: () => ({}), context: {},
      blockedUntil: () => null, chosen: () => [], engineName: (id) => id, tell: () => {}, record: () => {},
    });
    takeover.noteRuntimeEvent("fixture", { instanceId: instance.instanceId, model: REFUSED }, error!);
    return takeover.modelHeld({ instanceId: instance.instanceId, model: OTHER });
  } finally { recorder.stop(); }
}

function lifecycleInput(instanceId: string, dir: string, generation = "current", key = "fixture-key") {
  writeFileSync(join(dir, "failure.json"), JSON.stringify({ code: "QUOTA_EXCEEDED", message: MESSAGE }));
  return {
    instanceId, displayName: "OpenCode", enabled: true,
    config: { cli: CLI, fullAuto: false, workspace: dir },
    environment: { HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir,
      OPENCODE_API_KEY: key, FIXTURE_GENERATION: generation,
      FAKE_ACP_MODELS: `${REFUSED},${OTHER}`, FAKE_ACP_RPC_FAILURE_FILE: join(dir, "failure.json") },
  };
}

it.each([false, true])("keeps a replacement's prices when its predecessor finishes discovery (disposed=%s)", async (disposed) => {
  const dir = mkdtempSync(join(tmpdir(), "omb-price-replacement-"));
  dirs.push(dir);
  const id = `replacement-${disposed}`;
  const started = deferred<void>();
  const pending = deferred<ModelCatalog>();
  const oldCatalog = prices("free");
  let held = false;
  let oldReads = 0;
  if (disposed) savedListing(id, 0);
  const driver = createOpenCodeDriver(async (environment) => {
    if (environment.FIXTURE_GENERATION !== "old") return prices("paid");
    oldReads++;
    if (held || disposed) { started.resolve(); return pending.promise; }
    return oldCatalog;
  }, { everyMs: Infinity, liveLists: [] });
  const old = await driver.create(lifecycleInput(id, dir, "old"));
  instances.push(old);
  held = true;
  const reading = disposed ? old.startupModelRefresh! : old.refreshModels!();
  await started.promise;
  const queued = disposed ? old.refreshModels!() : Promise.resolve();
  try {
    if (disposed) await old.dispose();
    const current = await driver.create(lifecycleInput(id, dir));
    instances.push(current);
    await current.startupModelRefresh;
    pending.resolve(oldCatalog);
    await reading;
    await queued;
    expect(await otherHeld(current, dir), "the replacement lists the sibling as paid").toBeNull();
    if (disposed) expect(oldReads, "a queued discovery must not contact the provider after disposal").toBe(1);
  } finally { pending.resolve(oldCatalog); await Promise.all([reading, queued]); }
});

it("keeps prices discovered by status when startup uses a fresh saved listing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-price-status-"));
  dirs.push(dir);
  const id = "status-prices";
  savedListing(id);
  let reads = 0;
  const driver = createOpenCodeDriver(async () => { reads++; return prices("free"); }, { everyMs: Infinity, liveLists: [] });
  const instance = await driver.create(lifecycleInput(id, dir, "current", ""));
  instances.push(instance);
  expect(reads).toBe(0);
  expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
  expect(reads).toBe(1);
  expect(await otherHeld(instance, dir), "status discovered the shared free allowance").not.toBeNull();
});

it("does not restore old status prices after a refresh invalidates them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-price-status-refresh-"));
  dirs.push(dir);
  const id = "status-refresh-prices";
  savedListing(id);
  const started = deferred<void>();
  const pending = deferred<ModelCatalog>();
  let first = true;
  const driver = createOpenCodeDriver(async () => {
    if (first) { first = false; started.resolve(); return pending.promise; }
    return prices("paid");
  }, { everyMs: Infinity, liveLists: [] });
  const instance = await driver.create(lifecycleInput(id, dir, "current", ""));
  instances.push(instance);
  const status = instance.snapshot();
  await started.promise;
  try {
    await instance.refreshModels!();
    pending.resolve(prices("free"));
    await status;
    expect(await otherHeld(instance, dir)).toBeNull();
  } finally { pending.resolve(prices("free")); await status; }
});

it("uses retained prices when the catalog default is absent from the live session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-price-fallback-"));
  dirs.push(dir);
  const catalog = prices("free");
  const instance = await createOpenCodeDriver(async () => catalog, { everyMs: Infinity, liveLists: [] }).create({
    instanceId: "priced-fallback", displayName: "OpenCode", enabled: true,
    config: { cli: CLI, fullAuto: false, workspace: dir },
    environment: { HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, OPENCODE_API_KEY: "fixture-key",
      FAKE_ACP_MODELS: `opencode/paid-first,${OTHER}` },
  });
  instances.push(instance);
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "priced-fallback", text: "hello" });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.find((event) => event.type === "session.started")).toMatchObject({ model: OTHER });
  } finally { recorder.stop(); }
});

function prices(other: "free" | "paid" | "unknown"): ModelCatalog {
  return parseOpenCodeModelsOutput([
    REFUSED, JSON.stringify({ cost: { input: 0, output: 0 } }),
    OTHER, JSON.stringify(other === "unknown" ? {} : { cost: { input: other === "free" ? 0 : 1, output: 0 } }),
  ].join("\n"))!;
}

it.each(["paid", "unknown"] as const)("does not reuse an old free price when the current price is %s", (price) => {
  prices("free");
  const current = prices(price);
  expect(openCodeLimitFacts(MESSAGE, REFUSED, current)).toEqual({ limit: "model" });
});

it("keeps the current free-price facts independent of another catalog", () => {
  const first = prices("free");
  const second = prices("paid");
  expect(openCodeLimitFacts(MESSAGE, REFUSED, first)).toEqual({ limit: "model", limitModels: [REFUSED, OTHER] });
  expect(openCodeLimitFacts(MESSAGE, REFUSED, second)).toEqual({ limit: "model" });
  expect(openCodeLimitFacts(MESSAGE, REFUSED)).toEqual({ limit: "model" });
  expect(openCodeLimitFacts("GoUsageLimitError: usage limit reached", REFUSED, first)).toEqual({ limit: "engine" });
});

it.each(["free", "paid", "unknown", "failed"] as const)("applies only current confirmed free prices after a %s refresh through the ACP driver", async (price) => {
  const dir = mkdtempSync(join(tmpdir(), "omb-opencode-prices-"));
  dirs.push(dir);
  const failure = join(dir, "failure.json");
  writeFileSync(failure, JSON.stringify({ code: "QUOTA_EXCEEDED", message: MESSAGE }));
  let current: "free" | typeof price = "free";
  const driver = createOpenCodeDriver(async () => {
    if (current === "failed") throw new Error("fixture discovery unavailable");
    return prices(current);
  });
  const instance = await driver.create({
    instanceId: `price-${price}`, displayName: "OpenCode", enabled: true,
    config: { cli: CLI, fullAuto: false, workspace: dir },
    environment: { HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, OPENCODE_API_KEY: "fixture-key",
      FAKE_ACP_MODELS: `${REFUSED},${OTHER}`, FAKE_ACP_RPC_FAILURE_FILE: failure },
  });
  instances.push(instance);
  await instance.startupModelRefresh;
  current = price;
  await instance.refreshModels?.();
  const recorder = recordEvents(instance.adapter);
  try {
    const { turnId } = await instance.adapter.sendTurn({ threadId: `price-${price}`, text: "hello", model: REFUSED });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const error = recorder.events.find((event) => event.type === "runtime.error" && event.turnId === turnId);
    expect(error).toMatchObject({ type: "runtime.error", limit: "model" });
    const takeover = createLimitTakeover({
      file: join(dir, "notices.json"), engines: () => [], configs: () => ({}), context: {},
      blockedUntil: () => null, chosen: () => [], engineName: (id) => id, tell: () => {}, record: () => {},
    });
    takeover.noteRuntimeEvent("fixture", { instanceId: instance.instanceId, model: REFUSED }, error!);
    expect(takeover.modelHeld({ instanceId: instance.instanceId, model: REFUSED })).not.toBeNull();
    const otherHold = takeover.modelHeld({ instanceId: instance.instanceId, model: OTHER });
    if (price === "free") expect(otherHold).not.toBeNull();
    else expect(otherHold).toBeNull();
  } finally {
    recorder.stop();
  }
});

it("uses each instance's own free prices when the instances share a driver", async () => {
  const driver = createOpenCodeDriver(async (environment) => prices(environment.FIXTURE_PRICE === "paid" ? "paid" : "free"));
  for (const price of ["free", "paid"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "omb-opencode-instance-prices-"));
    dirs.push(dir);
    const failure = join(dir, "failure.json");
    writeFileSync(failure, JSON.stringify({ code: "QUOTA_EXCEEDED", message: MESSAGE }));
    const instance = await driver.create({
      instanceId: `instance-${price}`, displayName: "OpenCode", enabled: true,
      config: { cli: CLI, fullAuto: false, workspace: dir },
      environment: { HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir,
        OPENCODE_API_KEY: "fixture-key", FIXTURE_PRICE: price, FAKE_ACP_MODELS: `${REFUSED},${OTHER}`, FAKE_ACP_RPC_FAILURE_FILE: failure },
    });
    instances.push(instance);
    await instance.startupModelRefresh;
  }
  for (const instance of instances) {
    const recorder = recordEvents(instance.adapter);
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId: instance.instanceId, text: "hello", model: REFUSED });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      const error = recorder.events.find((event) => event.type === "runtime.error" && event.turnId === turnId);
      expect(error).toMatchObject({ limit: "model" });
      if (instance.instanceId === "instance-free") expect(error).toHaveProperty("limitModels", [REFUSED, OTHER]);
      else expect(error?.type === "runtime.error" ? error.limitModels ?? [REFUSED] : []).toEqual([REFUSED]);
    } finally {
      recorder.stop();
    }
  }
});
