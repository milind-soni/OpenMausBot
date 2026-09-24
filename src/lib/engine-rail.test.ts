import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import { configuredModelInstances, splitEngineRail } from "./engine-rail";

describe("splitEngineRail", () => {
  it("keeps Cloud engines above Local engines", () => {
    const { subscription, custom } = splitEngineRail([
      { access: "subscription", instanceId: "claude" },
      { access: "custom", instanceId: "hermes" },
      { instanceId: "grok" },
      { access: "api", instanceId: "mistral" },
      { access: "custom", instanceId: "qwen" },
    ]);
    expect(subscription.map((row) => row.instanceId)).toEqual(["claude", "grok", "mistral"]);
    expect(custom.map((row) => row.instanceId)).toEqual(["hermes", "qwen"]);
  });

  it("hides the second group when nothing is custom-only", () => {
    const rows = [{ instanceId: "claude" }];
    expect(splitEngineRail(rows).custom).toEqual([]);
  });
});

describe("configuredModelInstances", () => {
  const cloud = { id: "cloud-model", label: "Cloud model" };
  const local = { id: "local-model", label: "Local model", custom: true, loaded: true, provider: "Local host" };
  const instance = (overrides: Partial<InstanceInfo> = {}): InstanceInfo => ({
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    access: "subscription",
    snapshot: { state: "available", authenticated: true },
    models: { default: cloud.id, options: [cloud, local] },
    ...overrides,
  });

  it("hides unavailable engines and engines without selectable models", () => {
    const ready = instance();
    const unavailable = instance({ instanceId: "unavailable", snapshot: { state: "unavailable", authenticated: true } });
    const unavailableLocal = instance({ instanceId: "unavailable-local", access: "custom", snapshot: { state: "unavailable" } });
    const empty = instance({ instanceId: "empty", models: { default: cloud.id, options: [] } });
    const emptyLocal = instance({ instanceId: "empty-local", access: "custom", models: { default: local.id, options: [] } });

    expect(configuredModelInstances([unavailable, empty, ready, unavailableLocal, emptyLocal])).toEqual([ready]);
  });

  it.each([true, undefined])("keeps cloud and custom models when authentication is %s", (authenticated) => {
    const explicitSubscription = instance({ snapshot: { state: "available", authenticated } });
    const legacy = instance({ instanceId: "legacy", access: undefined, snapshot: { state: "available", authenticated } });

    expect(configuredModelInstances([explicitSubscription, legacy])).toEqual([explicitSubscription, legacy]);
  });

  it("hides signed-out cloud models while retaining configured custom models", () => {
    const cloudOnly = instance({ instanceId: "cloud-only", snapshot: { state: "available", authenticated: false }, models: { default: cloud.id, options: [cloud] } });
    const mixed = instance({ snapshot: { state: "available", authenticated: false } });
    const legacy = instance({ instanceId: "legacy", access: undefined, snapshot: { state: "available", authenticated: false } });

    const configured = configuredModelInstances([cloudOnly, mixed, legacy]);

    expect(configured.map((engine) => engine.instanceId)).toEqual(["codex", "legacy"]);
    expect(configured.map((engine) => engine.models.options)).toEqual([[local], [local]]);
  });

  it.each([true, false, undefined])("keeps custom engines when authentication is %s", (authenticated) => {
    const custom = instance({ access: "custom", snapshot: { state: "available", authenticated } });

    expect(configuredModelInstances([custom])).toEqual([custom]);
  });

  it("filters each Claude account independently and preserves eligible account order", () => {
    const claude = (id: string, authenticated: boolean) => instance({
      instanceId: id,
      driverKind: "claudeAgent",
      displayName: id,
      snapshot: { state: "available", authenticated },
      models: { default: cloud.id, options: [cloud] },
    });
    const personal = claude("Personal", false);
    const work = claude("Work", true);
    const other = claude("Other", true);

    expect(configuredModelInstances([personal, work, other])).toEqual([work, other]);
  });

  it("leaves the original catalog intact so saved unavailable models retain their labels", () => {
    const signedOut = instance({ snapshot: { state: "available", authenticated: false } });
    const unavailable = instance({ instanceId: "unavailable", snapshot: { state: "unavailable" } });
    const catalog = [signedOut, unavailable];
    const before = structuredClone(catalog);
    for (const engine of catalog) {
      for (const option of engine.models.options) Object.freeze(option);
      Object.freeze(engine.models.options);
      Object.freeze(engine.models);
      Object.freeze(engine.snapshot);
      Object.freeze(engine);
    }
    Object.freeze(catalog);

    const configured = configuredModelInstances(catalog);

    expect(configured.map((engine) => engine.models.options)).toEqual([[local]]);
    expect(catalog).toEqual(before);
    expect(catalog[0].models.options.find((option) => option.id === cloud.id)?.label).toBe("Cloud model");
    expect(catalog[1].models.options.find((option) => option.id === cloud.id)?.label).toBe("Cloud model");
  });
});
