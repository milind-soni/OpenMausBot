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

  it("hides engines that are not installed, and engines without selectable models, when the bot is not on them", () => {
    const ready = instance();
    const unavailable = instance({ instanceId: "unavailable", snapshot: { state: "unavailable", authenticated: true } });
    const unavailableLocal = instance({ instanceId: "unavailable-local", access: "custom", snapshot: { state: "unavailable" } });
    const empty = instance({ instanceId: "empty", models: { default: cloud.id, options: [] } });
    const emptyLocal = instance({ instanceId: "empty-local", access: "custom", models: { default: local.id, options: [] } });

    expect(configuredModelInstances([unavailable, empty, ready, unavailableLocal, emptyLocal])).toEqual([ready]);
    expect(configuredModelInstances([unavailable, empty, ready, unavailableLocal, emptyLocal], "codex")).toEqual([ready]);
  });

  it.each([true, false, undefined])("keeps cloud and custom models when authentication is %s", (authenticated) => {
    const explicitSubscription = instance({ snapshot: { state: "available", authenticated } });
    const legacy = instance({ instanceId: "legacy", access: undefined, snapshot: { state: "available", authenticated } });

    expect(configuredModelInstances([explicitSubscription, legacy])).toEqual([explicitSubscription, legacy]);
  });

  it("keeps a signed-out engine with its whole catalog so the picker can show its sign-in card", () => {
    const cloudOnly = instance({ instanceId: "cloud-only", snapshot: { state: "available", authenticated: false }, models: { default: cloud.id, options: [cloud] } });
    const mixed = instance({ snapshot: { state: "available", authenticated: false } });
    const legacy = instance({ instanceId: "legacy", access: undefined, snapshot: { state: "available", authenticated: false } });

    const configured = configuredModelInstances([cloudOnly, mixed, legacy]);

    expect(configured.map((engine) => engine.instanceId)).toEqual(["cloud-only", "codex", "legacy"]);
    expect(configured.map((engine) => engine.models.options)).toEqual([[cloud], [cloud, local], [cloud, local]]);
  });

  it.each([true, false, undefined])("keeps custom engines when authentication is %s", (authenticated) => {
    const custom = instance({ access: "custom", snapshot: { state: "available", authenticated } });

    expect(configuredModelInstances([custom])).toEqual([custom]);
  });

  it("always keeps the engine the bot runs on, even when its CLI is missing or it lists nothing", () => {
    const missing = instance({ instanceId: "missing", snapshot: { state: "unavailable", reason: "`codex` CLI not found" } });
    const empty = instance({ instanceId: "empty", access: "custom", snapshot: { state: "unavailable" }, models: { default: local.id, options: [] } });
    const ready = instance({ instanceId: "ready" });

    expect(configuredModelInstances([missing, ready, empty], "missing")).toEqual([missing, ready]);
    expect(configuredModelInstances([missing, ready, empty], "empty")).toEqual([ready, empty]);
    // An empty selection (a bot sent to setup) keeps nothing extra.
    expect(configuredModelInstances([missing, ready, empty], "")).toEqual([ready]);
  });

  it("judges each Claude account on its own and preserves account order", () => {
    const claude = (id: string, snapshot: InstanceInfo["snapshot"]) => instance({
      instanceId: id,
      driverKind: "claudeAgent",
      displayName: id,
      snapshot,
      models: { default: cloud.id, options: [cloud] },
    });
    const personal = claude("Personal", { state: "available", authenticated: false });
    const work = claude("Work", { state: "available", authenticated: true });
    const missing = claude("Missing", { state: "unavailable", reason: "`claude` CLI not found" });
    const other = claude("Other", { state: "available", authenticated: true });

    expect(configuredModelInstances([personal, work, missing, other])).toEqual([personal, work, other]);
    expect(configuredModelInstances([personal, work, missing, other], "Missing")).toEqual([personal, work, missing, other]);
  });

  it("returns the catalog's own entries and leaves them intact so saved models keep their labels", () => {
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

    expect(configured).toEqual([signedOut]);
    expect(configured[0]).toBe(signedOut);
    expect(catalog).toEqual(before);
  });
});

// The Discord report: a person could no longer pick Claude at all. Claude
// vanished from every picker when `claude auth status` did not answer
// loggedIn:true in time, or when `claude --version` failed.
describe("Claude in the picker when Claude Code is signed out or not found", () => {
  const official = [{ id: "claude-opus-5-5", label: "Opus 5.5" }, { id: "claude-sonnet-5", label: "Sonnet 5" }];
  const ollama = { id: "ollama:qwen3", label: "qwen3", custom: true, provider: "Ollama" };
  const claude = (snapshot: InstanceInfo["snapshot"], options: InstanceInfo["models"]["options"] = official): InstanceInfo => ({
    instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription", snapshot,
    models: { default: "claude-opus-5-5", options },
  });

  it("shows a signed-in Claude", () => {
    expect(configuredModelInstances([claude({ state: "available", authenticated: true })])).toHaveLength(1);
  });

  it("keeps a signed-out Claude and its official models, whichever engine the bot is on", () => {
    const signedOut = claude({ state: "available", authenticated: false });
    for (const selected of [undefined, "codex", "claude"]) {
      expect(configuredModelInstances([signedOut], selected)).toEqual([signedOut]);
    }
  });

  it("keeps local models found at startup next to the official ones for a signed-out Claude", () => {
    const [kept] = configuredModelInstances([claude({ state: "available", authenticated: false }, [...official, ollama])]);
    expect(kept.models.options).toEqual([...official, ollama]);
  });

  it("keeps a Claude whose CLI is not found only while the bot runs on it", () => {
    const missing = claude({ state: "unavailable", reason: "`claude` CLI not found" });
    expect(configuredModelInstances([missing], "claude")).toEqual([missing]);
    expect(configuredModelInstances([missing])).toEqual([]);
    expect(configuredModelInstances([missing], "codex")).toEqual([]);
  });
});
