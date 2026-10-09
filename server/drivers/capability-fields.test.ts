// Capability-field contract tests for the cloud computer. Whether an engine
// can work on it is one rule over one fact (shared/cloud-computer.ts): it has
// computer tools (computerMcp). Every turn runs on the bot's own engine; the
// fleet check at the bottom keeps any driver from running a turn elsewhere.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canWorkOnCloud } from "../../shared/cloud-computer.ts";
import { cloudPlaceRefusal } from "../surface.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { PiDriver } from "./pi.ts";

const created: ProviderInstance[] = [];
const onBoat = (instance: ProviderInstance) =>
  canWorkOnCloud({ computerMcp: instance.adapter.capabilities.computerMcp });
const keep = async (promise: Promise<ProviderInstance>): Promise<ProviderInstance> => {
  const instance = await promise;
  created.push(instance);
  return instance;
};

describe("typed capability fields for the cloud computer", () => {
  beforeEach(() => {
    ensureDirs();
  });

  afterEach(async () => {
    for (const instance of created.splice(0)) await instance.dispose();
  });

  it("keeps the chat runtime's cloud computer locked to its computer tools", async () => {
    const mounted = await keep(OpenAICompatDriver.create({
      instanceId: "caps-compat", displayName: "Caps Compat", environment: {}, enabled: true,
      config: OpenAICompatDriver.defaultConfig(),
    }));
    expect(mounted.adapter.capabilities.computerMcp).toBe(true);
    expect(onBoat(mounted)).toBe(true);
    // Tools off means the runtime has no computer tools to mount the cloud
    // computer into, so both gates must fall together.
    const bare = await keep(OpenAICompatDriver.create({
      instanceId: "caps-compat-bare", displayName: "Caps Compat Bare", environment: {}, enabled: true,
      config: { ...OpenAICompatDriver.defaultConfig(), tools: false },
    }));
    expect(bare.adapter.capabilities.computerMcp).toBe(false);
    expect(onBoat(bare)).toBe(false);
    // What a turn set to Cloud then gets: refused before anything starts, in
    // one plain line with the next step, not handed to some other engine.
    expect(cloudPlaceRefusal({ computerMcp: bare.adapter.capabilities.computerMcp, name: "Caps Compat Bare" }, "works-on", "Scout")?.message)
      .toBe("Caps Compat Bare can't use a computer. Choose a model that can, such as Claude or ChatGPT. Choose another model in Scout's settings.");
    expect(cloudPlaceRefusal({ computerMcp: mounted.adapter.capabilities.computerMcp, name: "Caps Compat" }, "works-on", "Scout")).toBeNull();
  });

  it("lets host-harness drivers with computer tools use the cloud computer on their own engine", async () => {
    // These once ran on a swapped-in engine on Boat's own runner, which could
    // not sign in on a Cloud (provider_not_configured).
    const claude = await keep(ClaudeDriver.create({
      instanceId: "caps-claude", displayName: "Caps Claude", environment: {}, enabled: true,
      config: ClaudeDriver.defaultConfig(),
    }));
    expect(onBoat(claude)).toBe(true);
    const codex = await keep(CodexDriver.create({
      instanceId: "caps-codex", displayName: "Caps Codex", environment: {}, enabled: true,
      config: CodexDriver.defaultConfig(),
    }));
    expect(onBoat(codex)).toBe(true);
    const pi = await keep(PiDriver.create({
      instanceId: "caps-pi", displayName: "Caps Pi", environment: {}, enabled: true,
      config: PiDriver.defaultConfig(),
    }));
    expect(onBoat(pi)).toBe(true);
  });

  it("registers no driver that runs a turn somewhere other than its own engine", async () => {
    expect(BUILT_IN_DRIVERS.map(driver => driver.driverKind)).not.toContain("boxAgent");
    for (const driver of BUILT_IN_DRIVERS) {
      const instance = await keep(driver.create({
        instanceId: `caps-fleet-${driver.driverKind}`, displayName: "Caps Fleet", environment: {}, enabled: true,
        config: driver.driverKind === "customAcp" ? { cli: "echo" } : {},
      }));
      // The cloud computer is a tool: no driver declares that its turn runs
      // somewhere else (the removed engine's remoteAgent flag).
      expect(instance.adapter.capabilities, driver.driverKind).not.toHaveProperty("remoteAgent");
    }
  });
});
