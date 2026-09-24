// The registry's contract is forward/backward compatibility: a config
// written by a newer or differently-built app must load as an
// unavailable shadow, never crash the fleet. These tests pin that.
import { describe, expect, it } from "vitest";

import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry } from "./registry.ts";

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
    // decodeConfig must NOT have been called — defaultConfig() is used verbatim
    expect(fake.decodedConfigs).toHaveLength(0);
    expect(registry.get("a")).not.toBeNull();
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

  it("describe() reports a snapshot() failure as unavailable rather than throwing", async () => {
    const fake = makeFakeDriver({ failSnapshot: "provider probe exploded" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "provider probe exploded" });
  });

  it("refreshes added and removed models and marks failed refreshes stale", async () => {
    let options = [{ id: "new", label: "New" }, { id: "old", label: "Old" }];
    let fail = false;
    let calls = 0;
    const fake = makeFakeDriver({ discoverModels: async () => {
      calls++;
      if (fail) throw new Error("offline");
      return { default: options[0].id, options };
    } });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    const first = await registry.modelCatalog("a");
    expect(first).toMatchObject({ status: "ready", default: "new" });
    options = [{ id: "later", label: "Later" }];
    expect((await registry.modelCatalog("a")).options).toHaveLength(2);
    const refreshed = await registry.modelCatalog("a", true);
    expect(refreshed.options.map((m) => m.id)).toEqual(["later"]);
    expect(calls).toBe(2);
    fail = true;
    const stale = await registry.modelCatalog("a", true);
    expect(stale).toMatchObject({ status: "stale", error: "offline" });
    expect(stale.options.map((m) => m.id)).toEqual(["later"]);
  });

  it("shares one in-flight discovery across simultaneous picker requests", async () => {
    let finish!: (value: { default: string; options: Array<{ id: string; label: string }> }) => void;
    let calls = 0;
    const fake = makeFakeDriver({ discoverModels: () => {
      calls++;
      return new Promise((resolve) => { finish = resolve; });
    } });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    const first = registry.modelCatalog("a", true);
    const second = registry.modelCatalog("a", true);
    expect(calls).toBe(1);
    finish({ default: "model-1", options: [{ id: "model-1", label: "Model 1" }] });
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ default: "model-1" }),
      expect.objectContaining({ default: "model-1" }),
    ]);
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
