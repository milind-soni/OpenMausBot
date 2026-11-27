import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelSelection } from "../contracts.ts";
import { selectDefaultModelSelection, type SelectableInstance } from "../default-model-selection.ts";
import { ENGINE_LIST_REUSE_MS, ProviderRegistry } from "../harness/registry.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { SUGGESTION_MAX_AGE_MS, suggestedSelection } from "./suggested-selection.ts";

afterEach(() => vi.useRealTimers());

async function engines(saved?: ModelSelection) {
  const fake = makeFakeDriver();
  const registry = new ProviderRegistry([fake.driver]);
  await registry.load({ a: { driver: "fake" } });
  let changed = 0;
  const suggest = () => suggestedSelection<SelectableInstance>({
    reused: (age) => registry.describe({ reuse: { ...age, changed: () => { changed += 1; } } }),
    fresh: () => registry.describe(),
    select: async (instances) => selectDefaultModelSelection(instances, saved),
  });
  return { fake, registry, suggest, changed: () => changed };
}

describe("suggestedSelection", () => {
  it("reads every engine when none was read yet, and answers as a fresh read does", async () => {
    const { fake, registry, suggest } = await engines();
    const answer = await suggest();
    expect(fake.probes).toHaveLength(1);
    expect(answer.instanceId).toBe("a");
    expect(answer).toEqual(selectDefaultModelSelection(await registry.describe()));
  });

  it("probes no CLI once the engine list holds a status that names an engine", async () => {
    const { fake, registry, suggest } = await engines();
    await registry.describe({ reuse: { ms: ENGINE_LIST_REUSE_MS, changed: () => {} } });
    const before = fake.probes.length;
    const first = await suggest();
    expect(await suggest()).toEqual(first);
    expect(first.instanceId).toBe("a");
    expect(fake.probes).toHaveLength(before);
  });

  it("reads again after anything in the app changed an engine's status", async () => {
    const { fake, registry, suggest } = await engines();
    await suggest();
    const before = fake.probes.length;
    registry.forgetSnapshots();
    await suggest();
    expect(fake.probes.length).toBeGreaterThan(before);
  });

  it("answers from a status under ten minutes old and reads the engine first once it is older", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { fake, suggest } = await engines();
    await suggest();
    const before = fake.probes.length;
    vi.setSystemTime(Date.now() + ENGINE_LIST_REUSE_MS - 1_000);
    await suggest();
    expect(fake.probes).toHaveLength(before);
    vi.setSystemTime(Date.now() + SUGGESTION_MAX_AGE_MS + 1_000);
    await suggest();
    expect(fake.probes).toHaveLength(before + 1);
  });

  it("reads every engine again when the held statuses name none", async () => {
    const calls: string[] = [];
    const answer = await suggestedSelection<string>({
      reused: async () => { calls.push("reused"); return ["signed out"]; },
      fresh: async () => { calls.push("fresh"); return ["signed in"]; },
      select: async (instances) => instances[0] === "signed in" ? { instanceId: "a", model: "m" } : { instanceId: "", model: "" },
    });
    expect(calls).toEqual(["reused", "fresh"]);
    expect(answer).toEqual({ instanceId: "a", model: "m" });
  });

  it("keeps a saved choice whose engine is not ready as no choice, after a fresh read", async () => {
    const { fake, suggest } = await engines({ instanceId: "gone", model: "m" });
    expect(await suggest()).toEqual({ instanceId: "", model: "" });
    expect(fake.probes.length).toBeGreaterThan(0);
  });
});
