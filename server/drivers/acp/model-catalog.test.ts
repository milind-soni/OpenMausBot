import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ModelCatalog } from "../../contracts.ts";
import { readStartupModelCacheEntry } from "../../startup-model-catalog.ts";
import { acpDiscoveryProblem, AcpDiscoveryTimeoutError, discoverAcpModels } from "./custom-model-catalog.ts";
import { acpModelCatalog } from "./model-catalog.ts";

const FAKE_ACP_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");
const MODELS = Array.from({ length: 5 }, (_, index) => `fixture-model-${index}`);
const FIXED: ModelCatalog = { default: "agent-default", options: [{ id: "agent-default", label: "Default" }] };
const efforts = (value: string) => ({ currentValue: value, options: [{ value, name: value }] });

function read(variant: string, extra: Record<string, string> = {}): Promise<ModelCatalog> {
  return discoverAcpModels({
    ...process.env, FAKE_ACP_MODELS: MODELS.join(","),
    FAKE_ACP_VARIANTS: JSON.stringify(Object.fromEntries(MODELS.map((model) => [model, efforts(variant)]))), ...extra,
  }, FAKE_ACP_CLI, [], { passthrough: FIXED.options[0], variantLimit: 128 });
}

const effortsOf = (catalog: ModelCatalog) => Object.fromEntries(catalog.options.map((option) => [option.id, option.variants?.map((variant) => variant.id)]));

describe("ACP model catalog reads", () => {
  it("keeps an earlier read's efforts for the models a cut-short read did not reach, and reads again at the next start", async () => {
    const instanceId = `catalog-cut-${Math.random().toString(36).slice(2)}`;
    let next = () => read("high");
    const catalog = acpModelCatalog({ instanceId, fixed: FIXED, startFromSaved: true, resolve: () => next() });
    await catalog.refresh(true);
    expect(readStartupModelCacheEntry(instanceId)?.checkedAt).toBeGreaterThan(0);

    next = () => read("low", { FAKE_ACP_EXIT_ON_MODEL: MODELS[2] });
    await catalog.refresh(true);
    expect(catalog.models.options.map((option) => option.id)).toEqual(["agent-default", ...MODELS]);
    expect(effortsOf(catalog.models)).toEqual({
      "agent-default": undefined,
      [MODELS[0]]: ["low"], [MODELS[1]]: ["low"], [MODELS[2]]: ["high"], [MODELS[3]]: ["high"], [MODELS[4]]: ["high"],
    });
    expect(catalog.unconfirmed).toBe(false);
    expect(catalog.unreadable).toBeUndefined();
    expect(readStartupModelCacheEntry(instanceId)?.checkedAt).toBe(0);
  });

  it("says why a read failed while the list is unconfirmed, and forgets it once a read succeeds", async () => {
    let next: () => Promise<ModelCatalog> = () => Promise.reject(new AcpDiscoveryTimeoutError("ACP model discovery timed out."));
    const catalog = acpModelCatalog({
      instanceId: `catalog-why-${Math.random().toString(36).slice(2)}`, fixed: FIXED, startFromSaved: false,
      resolve: () => next(), explain: (error) => acpDiscoveryProblem(error),
    });
    await catalog.refresh(true);
    expect(catalog.models).toEqual(FIXED);
    expect(catalog.unconfirmed).toBe(true);
    expect(catalog.unreadable).toBe("timedOut");

    next = () => Promise.reject(new Error("ACP agent closed during model discovery."));
    await catalog.refresh(true);
    expect(catalog.unreadable).toBe("failed");

    next = () => read("high");
    await catalog.refresh(true);
    expect(catalog.unconfirmed).toBe(false);
    expect(catalog.unreadable).toBeUndefined();

    // A failure after a good read leaves that read's list standing, with nothing to explain.
    next = () => Promise.reject(new AcpDiscoveryTimeoutError("ACP model discovery timed out."));
    await catalog.refresh(true);
    expect(catalog.models.options).toHaveLength(MODELS.length + 1);
    expect(catalog.unreadable).toBeUndefined();
  });
});
