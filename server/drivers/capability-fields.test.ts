// Capability-field contract tests: remoteAgent and usesCloudComputer are the
// typed replacements for the boxAgent composite reads in dispatch and rooms.
// The fleet invariant at the bottom is the zero-behavior-change proof for
// every swapped site: usesCloudComputer must equal the union it replaces, and
// remoteAgent must be declared by exactly the boat-native driver.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { BoatAgentDriver } from "./boatagent.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { PiDriver } from "./pi.ts";

const created: ProviderInstance[] = [];
const keep = async (promise: Promise<ProviderInstance>): Promise<ProviderInstance> => {
  const instance = await promise;
  created.push(instance);
  return instance;
};

describe("typed capability fields (remoteAgent / usesCloudComputer)", () => {
  beforeEach(() => {
    ensureDirs();
  });

  afterEach(async () => {
    for (const instance of created.splice(0)) await instance.dispose();
  });

  it("declares the box-native engine remote and cloud-bound without a bridge mount", async () => {
    const boat = await keep(BoatAgentDriver.create({
      instanceId: "caps-box", displayName: "Caps Boat",
      environment: { BOX_TOKEN: "boat-test-token" }, enabled: true, config: { pollMs: 0 },
    }));
    expect(boat.adapter.capabilities.remoteAgent).toBe(true);
    expect(boat.adapter.capabilities.usesCloudComputer).toBe(true);
    // The agent switches to Boat's model — it never consumes the descriptor,
    // so cloudComputerMcp stays absent (its own contract excludes it).
    expect(boat.adapter.capabilities.cloudComputerMcp).toBeUndefined();
  });

  it("keeps usesCloudComputer locked to cloudComputerMcp on the chat runtime", async () => {
    const mounted = await keep(OpenAICompatDriver.create({
      instanceId: "caps-compat", displayName: "Caps Compat", environment: {}, enabled: true,
      config: OpenAICompatDriver.defaultConfig(),
    }));
    expect(mounted.adapter.capabilities.cloudComputerMcp).toBe(true);
    expect(mounted.adapter.capabilities.usesCloudComputer).toBe(true);
    expect(mounted.adapter.capabilities.remoteAgent).toBeUndefined();
    // Tools off means the runtime cannot mount the leased descriptor either,
    // so both gates must fall together.
    const bare = await keep(OpenAICompatDriver.create({
      instanceId: "caps-compat-bare", displayName: "Caps Compat Bare", environment: {}, enabled: true,
      config: { ...OpenAICompatDriver.defaultConfig(), tools: false },
    }));
    expect(bare.adapter.capabilities.cloudComputerMcp).toBe(false);
    expect(bare.adapter.capabilities.usesCloudComputer).toBe(false);
  });

  it("leaves host-harness drivers without either field", async () => {
    const claude = await keep(ClaudeDriver.create({
      instanceId: "caps-claude", displayName: "Caps Claude", environment: {}, enabled: true,
      config: ClaudeDriver.defaultConfig(),
    }));
    expect(claude.adapter.capabilities.remoteAgent).toBeUndefined();
    expect(claude.adapter.capabilities.usesCloudComputer).toBeUndefined();
    const codex = await keep(CodexDriver.create({
      instanceId: "caps-codex", displayName: "Caps Codex", environment: {}, enabled: true,
      config: CodexDriver.defaultConfig(),
    }));
    expect(codex.adapter.capabilities.remoteAgent).toBeUndefined();
    expect(codex.adapter.capabilities.usesCloudComputer).toBeUndefined();
    const pi = await keep(PiDriver.create({
      instanceId: "caps-pi", displayName: "Caps Pi", environment: {}, enabled: true,
      config: PiDriver.defaultConfig(),
    }));
    expect(pi.adapter.capabilities.remoteAgent).toBeUndefined();
    expect(pi.adapter.capabilities.usesCloudComputer).toBeUndefined();
  });

  it("holds the fleet invariant the swapped reads rely on", async () => {
    for (const driver of BUILT_IN_DRIVERS) {
      const instance = await keep(driver.create({
        instanceId: `caps-fleet-${driver.driverKind}`, displayName: "Caps Fleet", environment: {}, enabled: true,
        config: driver.driverKind === "customAcp" ? { cli: "echo" } : {},
      }));
      const caps = instance.adapter.capabilities;
      // remoteAgent is exactly the boat-native driver: this biconditional is
      // what lets every former driverKind === "boxAgent" capability read
      // become caps.remoteAgent === true without changing an outcome.
      expect(caps.remoteAgent === true, driver.driverKind).toBe(driver.driverKind === "boxAgent");
      // usesCloudComputer is exactly the union it replaces at the attach and
      // readiness sites (remoteAgent || cloudComputerMcp).
      expect(caps.usesCloudComputer === true, driver.driverKind)
        .toBe(caps.remoteAgent === true || caps.cloudComputerMcp === true);
    }
  });
});
