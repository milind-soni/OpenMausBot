// A config written by a newer or differently built app must load as an unavailable shadow, never crash the fleet.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelCatalog, StandaloneRelease } from "../contracts.ts";
import { standalonePlatformKey } from "../engine-standalone.ts";
import { findCliCandidates, registerFallbackPathDir, registerPathDir, resetPathCache, resetPathCacheForTests } from "../env-path.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry, SNAPSHOT_DEADLINE_MS, SNAPSHOT_REUSE_MS } from "./registry.ts";

describe("ProviderRegistry", () => {
  it("creates live instances for known drivers", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake", displayName: "Bot A" } });

    const live = registry.get("a");
    expect(live).not.toBeNull();
    expect(live!.driverKind).toBe("fake");
    expect(live!.displayName).toBe("Bot A");
    expect(registry.instances()).toHaveLength(1);
  });

  it("uses defaultConfig when the entry has no config", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    expect(fake.decodedConfigs).toHaveLength(0);
    expect(registry.get("a")).not.toBeNull();
  });

  it("reports cli as overridden only when the raw config sets it", async () => {
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      untouched: { driver: "fake", config: { other: true } },
      overridden: { driver: "fake", config: { cli: "/opt/fake/custom-bin" } },
      bare: { driver: "fake" },
    });

    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(described.untouched.cli).toBeUndefined();
    expect(described.bare.cli).toBeUndefined();
    expect(described.overridden.cli).toBe("/opt/fake/custom-bin");
    expect(described.untouched.cliDefault).toBe("fakebin");
    expect(described.untouched.access).toBe("subscription");
  });

  it("resolves maintenance commands to the configured CLI or driver default", async () => {
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      defaulted: { driver: "fake" },
      overridden: { driver: "fake", config: { cli: "/opt/fake/custom-bin" } },
    });

    expect(registry.cliTarget("defaulted")).toEqual({ driverKind: "fake", cli: "fakebin" });
    expect(registry.cliTarget("overridden")).toEqual({ driverKind: "fake", cli: "/opt/fake/custom-bin" });
    expect(registry.cliTarget("missing")).toBeNull();
  });

  it("publishes custom-only access from driver metadata", async () => {
    const fake = makeFakeDriver();
    Object.assign(fake.driver.metadata, { access: "custom" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ local: { driver: "fake" } });
    const [described] = await registry.describe();
    expect(described.access).toBe("custom");
  });

  it("keeps an unknown driver as an unavailable shadow instead of failing", async () => {
    const registry = new ProviderRegistry([makeFakeDriver().driver]);
    await registry.load({ mystery: { driver: "from-the-future", displayName: "Tomorrow" } });

    expect(registry.get("mystery")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot.state).toBe("unavailable");
    expect(described.snapshot.reason).toContain("from-the-future");
    expect(described.displayName).toBe("Tomorrow");
    expect(described.models.options).toHaveLength(0);
    expect(registry.cliTarget("mystery")).toEqual({ driverKind: "from-the-future", cli: null });
  });

  it("downgrades a config-decode failure to a shadow with the error as reason", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ broken: { driver: "fake", config: { bad: true } } });

    expect(registry.get("broken")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "fake: bad config" });
  });

  it("downgrades a create() rejection to a shadow without touching siblings", async () => {
    const good = makeFakeDriver({ kind: "good" });
    const flaky = makeFakeDriver({ kind: "flaky", failCreate: "boom at create" });
    const registry = new ProviderRegistry([good.driver, flaky.driver]);
    await registry.load({
      g: { driver: "good" },
      f: { driver: "flaky" },
    });

    expect(registry.get("g")).not.toBeNull();
    expect(registry.get("f")).toBeNull();
    const described = await registry.describe();
    const f = described.find((d) => d.instanceId === "f")!;
    expect(f.snapshot).toMatchObject({ state: "unavailable", reason: "boom at create" });
  });

  it("creates instances concurrently while keeping config order and failure isolation", async () => {
    const first = makeFakeDriver({ kind: "first" });
    const second = makeFakeDriver({ kind: "second" });
    const broken = makeFakeDriver({ kind: "broken", failCreate: "boom at create" });
    // "second" is released before "first", so completion order is the reverse of config order.
    const started: string[] = [];
    const release = [first, second, broken].map((handle) => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const create = handle.driver.create.bind(handle.driver);
      handle.driver.create = async (input) => {
        started.push(input.instanceId);
        await gate;
        return create(input);
      };
      return open;
    });
    const registry = new ProviderRegistry([first.driver, second.driver, broken.driver]);
    const loading = registry.load({
      first: { driver: "first" },
      second: { driver: "second" },
      broken: { driver: "broken" },
    });
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    let done = false;
    void loading.then(() => (done = true));
    await settle();
    expect(started).toEqual(["first", "second", "broken"]);
    expect(done).toBe(false);
    release[1]();
    await settle();
    expect(registry.get("second")).not.toBeNull();
    expect(registry.get("first")).toBeNull();
    release[0]();
    release[2]();
    await loading;

    expect(registry.instances().map((i) => i.instanceId)).toEqual(["first", "second"]);
    expect(registry.entries().map((e) => e.instanceId)).toEqual(["first", "second", "broken"]);
    expect(registry.get("broken")).toBeNull();
    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(Object.keys(described)).toEqual(["first", "second", "broken"]);
    expect(described.broken.snapshot).toMatchObject({ state: "unavailable", reason: "boom at create" });
  });

  it("does not bring back an instance disposed while a slower one is still loading", async () => {
    const fast = makeFakeDriver({ kind: "fast" });
    const slow = makeFakeDriver({ kind: "slow" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const create = slow.driver.create.bind(slow.driver);
    slow.driver.create = async (input) => {
      await gate;
      return create(input);
    };
    const registry = new ProviderRegistry([fast.driver, slow.driver]);
    const loading = registry.load({ fast: { driver: "fast" }, slow: { driver: "slow" } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(registry.get("fast")).not.toBeNull();
    await registry.disposeAll();
    release();
    await loading;
    expect(registry.get("fast")).toBeNull();
    expect(registry.entries().map((e) => e.instanceId)).toEqual(["slow"]);
  });

  it("keeps a replaced instance in its place and adds a new one at the end", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" }, c: { driver: "fake" } });
    const before = registry.get("b");
    await registry.load({ b: { driver: "fake", displayName: "Rebuilt" }, d: { driver: "fake" } });
    expect(registry.entries().map((e) => e.instanceId)).toEqual(["a", "b", "c", "d"]);
    expect(registry.get("b")).not.toBe(before);
    expect(registry.get("b")?.displayName).toBe("Rebuilt");
  });

  it("describe() reports a snapshot() failure as unavailable rather than throwing", async () => {
    const fake = makeFakeDriver({ failSnapshot: "provider probe exploded" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "provider probe exploded" });
  });

  it("describe() reports a snapshot() that never settles as unavailable, so the other engines are still read", async () => {
    vi.useFakeTimers();
    try {
      const stuck = makeFakeDriver({ kind: "stuck", hangSnapshot: true });
      const fine = makeFakeDriver({ kind: "fine" });
      const registry = new ProviderRegistry([stuck.driver, fine.driver]);
      await registry.load({ a: { driver: "stuck" }, b: { driver: "fine" } });

      const read = registry.describe();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEADLINE_MS);
      const described = Object.fromEntries((await read).map((d) => [d.instanceId, d.snapshot.state]));
      expect(described).toEqual({ a: "unavailable", b: "available" });

      const direct = registry.get("a")!.snapshot();
      const settled = expect(direct).rejects.toThrow("did not report its status within a minute");
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEADLINE_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards a live instance's declared effort levels in describe()", async () => {
    const fake = makeFakeDriver({ effortLevels: ["low", "high"] });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toEqual(["low", "high"]);
  });

  it("omits effortLevels from describe() when the driver declares none", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toBeUndefined();
  });

  it("exposes model-variant support without manufacturing an effort list", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    registry.get("a")!.adapter.capabilities.modelVariants = true;
    const [described] = await registry.describe();
    expect(described.capabilities.modelVariants).toBe(true);
    expect(described.capabilities.effortLevels).toBeUndefined();
  });

  it("reports whether an instance supports isolated approval review", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    expect((await registry.describe())[0].capabilities.approvalReview).toBe(false);
    Object.assign(registry.get("a")!, { reviewPermission: async () => "ok" });
    expect((await registry.describe())[0].capabilities.approvalReview).toBe(true);
  });

  it("reports whether an instance can make the background steps' one-shot call", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    expect((await registry.describe()).map((item) => item.capabilities.backgroundText)).toEqual([false, false]);
    Object.assign(registry.get("a")!, { generateText: async () => "ok" });
    Object.assign(registry.get("b")!, { generateMemoryText: async () => "ok" });
    expect((await registry.describe()).map((item) => item.capabilities.backgroundText)).toEqual([true, true]);
  });

  it("refreshes a live model catalog only on an explicit provider action", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });
    const refreshes = { a: 0, b: 0 };
    for (const instanceId of ["a", "b"] as const) {
      const instance = registry.get(instanceId)!;
      const models: ModelCatalog = { default: "", options: [] };
      Object.assign(instance, {
        models,
        refreshModels: async () => {
          refreshes[instanceId] += 1;
          const id = `${instanceId}-${refreshes[instanceId]}`;
          models.default = id;
          models.options = [{ id, label: `Dynamic ${id}` }];
        },
      });
    }

    await registry.refreshModels("a");
    await registry.refreshModels("b");
    const first = Object.fromEntries((await registry.describe()).map((row) => [row.instanceId, row.models]));
    expect(first.a.default).toBe("a-1");
    expect(first.b.default).toBe("b-1");

    await registry.refreshModels("a");
    await registry.refreshModels("b");
    const second = Object.fromEntries((await registry.describe()).map((row) => [row.instanceId, row.models]));
    expect(second.a.default).toBe("a-2");
    expect(second.b.default).toBe("b-2");
    expect(refreshes).toEqual({ a: 2, b: 2 });
  });

  it("probes each engine once for concurrent reads, and every reader gets that probe's answer", async () => {
    let release!: () => void;
    const fake = makeFakeDriver({ holdSnapshot: new Promise<void>((resolve) => (release = resolve)) });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    const described = Promise.all([registry.describe(), registry.describe(), registry.describe()]);
    const direct = registry.get("a")!.snapshot();
    expect(fake.probes.sort()).toEqual(["a", "b"]);
    release();
    for (const rows of await described) {
      expect(rows.map((row) => [row.instanceId, row.snapshot])).toEqual([["a", { state: "available", version: "0.0.0-fake" }], ["b", { state: "available", version: "0.0.0-fake" }]]);
    }
    expect(await direct).toEqual({ state: "available", version: "0.0.0-fake" });
    expect(fake.probes).toHaveLength(2);
  });

  it("answers a read within the reuse window from the probe that just finished, then probes again", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeDriver();
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ a: { driver: "fake" } });

      await registry.describe();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_REUSE_MS - 1);
      await registry.describe();
      expect(fake.probes).toEqual(["a"]);
      await vi.advanceTimersByTimeAsync(1);
      await registry.describe();
      expect(fake.probes).toEqual(["a", "a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a model list that arrived while the status read is reused", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    const models: ModelCatalog = { default: "old", options: [{ id: "old", label: "Old" }] };
    Object.defineProperty(registry.get("a")!, "models", { get: () => models });

    expect((await registry.describe())[0].models.default).toBe("old");
    models.default = "new";
    models.options = [{ id: "new", label: "New" }];
    expect((await registry.describe())[0].models).toEqual({ default: "new", options: [{ id: "new", label: "New" }] });
    expect(fake.probes).toEqual(["a"]);
  });

  it("probes again after a failed or timed-out read instead of reusing it", async () => {
    vi.useFakeTimers();
    try {
      const options: Parameters<typeof makeFakeDriver>[0] = { failSnapshot: "probe exploded" };
      const fake = makeFakeDriver(options);
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ a: { driver: "fake" } });

      expect((await registry.describe())[0].snapshot).toMatchObject({ state: "unavailable", reason: "probe exploded" });
      delete options.failSnapshot;
      options.hangSnapshot = true;
      const stuck = registry.describe();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEADLINE_MS);
      expect((await stuck)[0].snapshot).toMatchObject({ state: "unavailable", reason: expect.stringContaining("within a minute") });
      delete options.hangSnapshot;
      expect((await registry.describe())[0].snapshot).toMatchObject({ state: "available" });
      expect(fake.probes).toEqual(["a", "a", "a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("probes again after forgetSnapshots(), and never hands a later read the probe that was in flight", async () => {
    let release!: () => void;
    const options: Parameters<typeof makeFakeDriver>[0] = {};
    const fake = makeFakeDriver(options);
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    await registry.describe();
    registry.forgetSnapshots();
    await registry.describe();
    expect(fake.probes).toEqual(["a", "a"]);

    options.holdSnapshot = new Promise<void>((resolve) => (release = resolve));
    registry.forgetSnapshots();
    const before = registry.describe();
    registry.forgetSnapshots();
    const after = registry.describe();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fake.probes).toEqual(["a", "a", "a", "a"]);
    release();
    await Promise.all([before, after]);
    await registry.describe();
    expect(fake.probes).toHaveLength(4);
  });

  it("runs a decorator's own check on every read, and probes again after an install, a model refresh or a reload", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    let refused = false;
    await registry.load({ a: { driver: "fake" } }, (instance) => ({
      ...instance,
      snapshot: async () => refused ? { state: "unavailable", reason: "credit used up" } : instance.snapshot(),
      installRuntime: async () => {},
    }));

    expect((await registry.describe())[0].snapshot.state).toBe("available");
    refused = true;
    expect((await registry.describe())[0].snapshot).toMatchObject({ state: "unavailable", reason: "credit used up" });
    refused = false;
    expect((await registry.describe())[0].snapshot.state).toBe("available");
    expect(fake.probes).toEqual(["a"]);

    expect(await registry.installRuntime("a")).toBe(true);
    await registry.describe();
    expect(fake.probes).toEqual(["a", "a"]);

    expect(await registry.refreshModels("a")).toBe(true);
    await registry.describe();
    expect(fake.probes).toEqual(["a", "a", "a"]);

    await registry.load({ a: { driver: "fake", displayName: "Reloaded" } });
    await registry.describe();
    expect(fake.probes).toEqual(["a", "a", "a", "a"]);
  });

  it("disposeAll disposes every live instance and empties the registry", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    await registry.disposeAll();
    expect(fake.disposed.sort()).toEqual(["a", "b"]);
    expect(registry.entries()).toHaveLength(0);
    expect(registry.get("a")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("installing an npm engine from Settings", () => {
  // A stand-in npm on PATH: records its arguments and drops the expected executable into its prefix.
  const FAKE_NPM = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
const prefix = args[args.indexOf('--prefix') + 1];
mkdirSync(join(prefix, 'bin'), { recursive: true });
writeFileSync(join(prefix, 'bin', 'fakebin'), '#!/bin/sh\\necho fixture\\n', { mode: 0o755 });
process.exit(0);
`;
  let scratch: string;
  let originalPath: string | undefined;
  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_NPM_LOG;
    resetPathCacheForTests();
    await removeTempDir(scratch);
  });
  function addFakeNpm(binDir: string) {
    const npm = join(binDir, "npm");
    writeFileSync(npm, FAKE_NPM, { mode: 0o755 });
    chmodSync(npm, 0o755);
    resetPathCacheForTests();
  }
  function withFakeNpm(present: boolean): string {
    scratch = mkdtempSync(join(tmpdir(), "omb-registry-install-"));
    originalPath = process.env.PATH;
    const binDir = join(scratch, "fake-path");
    mkdirSync(binDir);
    if (present) addFakeNpm(binDir);
    process.env.PATH = binDir;
    process.env.FAKE_NPM_LOG = join(scratch, "npm-calls.jsonl");
    resetPathCacheForTests();
    return binDir;
  }

  it("advertises and runs the install only when the driver names an npm package and npm is on PATH", async () => {
    withFakeNpm(true);
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    Object.assign(fake.driver, { install: { command: { linux: "npm install -g fake-engine", darwin: "npm install -g fake-engine" }, needsNode: true } });
    const registry = new ProviderRegistry([fake.driver], { enginesBaseDir: join(scratch, "data") });
    await registry.load({ a: { driver: "fake" } });
    const [described] = await registry.describe();
    expect(described.install?.server).toEqual({ package: "fake-engine" });
    expect(described.install?.platform).toBe(process.platform);
    expect(await registry.installRuntime("a")).toBe(true);
    const calls = readFileSync(process.env.FAKE_NPM_LOG!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["install", "-g", "--prefix", join(scratch, "data", "tools", "npm"), "--loglevel=error", "--include=optional", "--allow-scripts=fake-engine", "fake-engine@latest"]);
    expect(existsSync(join(scratch, "data", "tools", "npm", "bin", "fakebin"))).toBe(true);
    expect(await registry.installRuntime("missing")).toBe(false);
  });

  function standaloneRelease(platform: string): StandaloneRelease {
    return {
      name: "Fake Engine",
      engine: "fake-engine",
      version: "2.0.0",
      hosts: ["downloads.example.test"],
      assets: { [platform]: { url: "https://downloads.example.test/fake", sha256: "a".repeat(64), executableSha256: "b".repeat(64), archive: "raw", executable: "fakebin", approxBytes: 70_000_000 } },
    };
  }

  it("installs the vendor's own build without npm, and shows it as available", async () => {
    withFakeNpm(false);
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const release = standaloneRelease(standalonePlatformKey());
    Object.assign(fake.driver, { install: { command: { linux: "npm install -g fake-engine", darwin: "npm install -g fake-engine" }, needsNode: true, standalone: release } });
    const installs: unknown[][] = [];
    const registry = new ProviderRegistry([fake.driver], {
      enginesBaseDir: join(scratch, "data"),
      npmAvailable: () => false,
      installStandalone: async (...args) => {
        installs.push(args);
        return { version: "2.0.0", executablePath: join(scratch, "data", "tools", "standalone", "fake-engine", "bin", "fakebin"), binDir: "" };
      },
    });
    await registry.load({ a: { driver: "fake" } });
    const [described] = await registry.describe();
    expect(described.install?.server).toEqual({ standalone: { version: "2.0.0", downloadBytes: 70_000_000 } });
    // The pins stay on the server.
    expect(described.install).not.toHaveProperty("standalone");
    expect(await registry.installRuntime("a")).toBe(true);
    expect(installs).toEqual([[release, { baseDir: join(scratch, "data") }]]);
    expect(existsSync(process.env.FAKE_NPM_LOG!)).toBe(false);
  });

  it("installs with npm when the vendor has no build for this platform", async () => {
    withFakeNpm(true);
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    Object.assign(fake.driver, { install: { command: { linux: "npm install -g fake-engine", darwin: "npm install -g fake-engine" }, standalone: standaloneRelease("plan9-x64") } });
    const installs: unknown[] = [];
    const registry = new ProviderRegistry([fake.driver], { enginesBaseDir: join(scratch, "data"), installStandalone: async (release) => {
      installs.push(release);
      return { version: "2.0.0", executablePath: "", binDir: "" };
    } });
    await registry.load({ a: { driver: "fake" } });
    expect((await registry.describe())[0].install?.server).toEqual({ package: "fake-engine" });
    expect(await registry.installRuntime("a")).toBe(true);
    expect(installs).toEqual([]);
    expect(readFileSync(process.env.FAKE_NPM_LOG!, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("drops the terminal sign-in command when the CLI is the app's own copy, which the person's terminal cannot reach", async () => {
    const own = withFakeNpm(false);
    const base = join(scratch, "data");
    const bin = join(base, "tools", "standalone", "fake-engine", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "fakebin"), "#!/bin/sh\n", { mode: 0o755 });
    registerFallbackPathDir(bin);
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    Object.assign(fake.driver, { install: { signInCommand: "fakebin auth login", standalone: standaloneRelease(standalonePlatformKey()) } });
    const registry = new ProviderRegistry([fake.driver], { enginesBaseDir: base, npmAvailable: () => false });
    await registry.load({ a: { driver: "fake" } });
    expect((await registry.describe())[0].install?.signInCommand).toBeUndefined();
    // So Settings can offer the in-app way to finish setting it up instead.
    expect((await registry.describe())[0].install?.appCopy).toBe(true);
    // A copy npm put in the app's folder earlier ranks behind the app's own build for such an engine.
    mkdirSync(join(base, "tools", "npm", "bin"), { recursive: true });
    writeFileSync(join(base, "tools", "npm", "bin", "fakebin"), "#!/bin/sh\n", { mode: 0o755 });
    registerPathDir(join(base, "tools", "npm", "bin"));
    expect((await registry.describe())[0].install?.signInCommand).toBeUndefined();
    // A copy the person installed comes first on PATH and keeps its sign-in command.
    writeFileSync(join(own, "fakebin"), "#!/bin/sh\n", { mode: 0o755 });
    resetPathCache();
    expect((await registry.describe())[0].install?.signInCommand).toBe("fakebin auth login");
    expect((await registry.describe())[0].install?.appCopy).toBeUndefined();
  });

  it("points the engine at the app's own copy when the copy its CLI finds does not start", async () => {
    const own = withFakeNpm(false);
    writeFileSync(join(own, "fakebin"), "#!/bin/sh\necho 'Error: Cannot find module' >&2\nexit 1\n", { mode: 0o755 });
    const base = join(scratch, "data");
    const bin = join(base, "tools", "standalone", "fake-engine", "bin");
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    Object.assign(fake.driver, { install: { standalone: standaloneRelease(standalonePlatformKey()) } });
    const registry = new ProviderRegistry([fake.driver], {
      enginesBaseDir: base,
      npmAvailable: () => false,
      installStandalone: async () => {
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "fakebin"), "#!/bin/sh\necho 2.0.0\n", { mode: 0o755 });
        registerFallbackPathDir(bin);
        return { version: "2.0.0", executablePath: join(bin, "fakebin"), binDir: bin };
      },
    });
    await registry.load({ a: { driver: "fake" } });
    // The engine's status runs its CLI, as the real drivers do.
    Object.assign(registry.get("a")!, {
      snapshot: async () => {
        try {
          execFileSync(findCliCandidates("fakebin")[0]!, ["--version"], { stdio: "pipe" });
          return { state: "available" };
        } catch {
          return { state: "unavailable", reason: "fakebin does not start" };
        }
      },
    });
    expect(await registry.installRuntime("a")).toEqual({ useCli: join(bin, "fakebin") });
    // A CLI the person chose with Set CLI is theirs to change, even when it does not start.
    await registry.load({ b: { driver: "fake", config: { cli: join(own, "fakebin") } } });
    Object.assign(registry.get("b")!, { snapshot: async () => ({ state: "unavailable", reason: "fakebin does not start" }) });
    expect(await registry.installRuntime("b")).toBe(true);
    // A working copy of the person's own is left alone.
    writeFileSync(join(own, "fakebin"), "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
    expect(await registry.installRuntime("a")).toBe(true);
  });

  it("lets a driver's own installer go first", async () => {
    withFakeNpm(false);
    const fake = makeFakeDriver();
    Object.assign(fake.driver, { install: { standalone: standaloneRelease(standalonePlatformKey()) } });
    const installs: unknown[] = [];
    let own = 0;
    const registry = new ProviderRegistry([fake.driver], { npmAvailable: () => false, installStandalone: async (release) => {
      installs.push(release);
      return { version: "2.0.0", executablePath: "", binDir: "" };
    } });
    await registry.load({ a: { driver: "fake" } }, (instance) => Object.assign(instance, { installRuntime: async () => { own += 1; } }));
    expect(await registry.installRuntime("a")).toBe(true);
    expect(own).toBe(1);
    expect(installs).toEqual([]);
  });

  it("offers nothing without npm, for a curl installer, or for a managed engine", async () => {
    withFakeNpm(true);
    const fake = makeFakeDriver();
    Object.assign(fake.driver, { install: { command: { linux: "npm install -g fake-engine" } } });
    // The PATH scan also looks in standard install locations, so "no npm" is injected rather than simulated.
    const without = new ProviderRegistry([fake.driver], { enginesBaseDir: join(scratch, "data"), npmAvailable: () => false });
    await without.load({ a: { driver: "fake" } });
    expect((await without.describe())[0].install?.server).toBeUndefined();
    expect(await without.installRuntime("a")).toBe(false);
    const registry = new ProviderRegistry([fake.driver], { enginesBaseDir: join(scratch, "data") });
    await registry.load({ a: { driver: "fake" } });
    Object.assign(fake.driver, { install: { command: { linux: "curl -fsSL https://example.test/install.sh | bash" } } });
    expect((await registry.describe())[0].install?.server).toBeUndefined();
    expect(await registry.installRuntime("a")).toBe(false);
    Object.assign(fake.driver, { install: { command: { linux: "npm install -g fake-engine" }, managed: { label: "Install", downloadBytes: 1 } } });
    expect((await registry.describe())[0].install?.server).toBeUndefined();
    expect(existsSync(join(scratch, "data"))).toBe(false);
  });
});
