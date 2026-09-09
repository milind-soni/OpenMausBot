import { describe, expect, it, vi } from "vitest";

import {
  discoverExistingPerBotLocalVms,
  localVmInventoryEntry,
  shouldArmLocalVmIdle,
} from "./local-vm-inventory.ts";
import {
  perBotLocalVmTarget,
  type ContainerComputerStatus,
} from "./container-computer.ts";

describe("Local VM inventory", () => {
  it("finds existing VMs even after their bots move away from Local VM", async () => {
    const bots = [
      { id: "vm", name: "VM bot", computer: "vm" as const },
      { id: "cloud", name: "Cloud bot", computer: "cloud" as const },
      { id: "off", name: "Off bot", computer: "off" as const },
      { id: "auto", name: "Auto bot" },
    ];
    const existingNames = new Set([
      perBotLocalVmTarget("cloud").containerName,
      perBotLocalVmTarget("off").containerName,
    ]);
    const exists = vi.fn(async (_runtime, target) => existingNames.has(target.containerName));

    const found = await discoverExistingPerBotLocalVms(bots, "docker", exists);

    expect(found.map(({ bot }) => bot.id)).toEqual(["cloud", "off"]);
    expect(exists).toHaveBeenCalledTimes(4);
  });

  it("publishes only the safe allow-listed fields and omits missing VMs", () => {
    const status = {
      container: "running",
      managed: true,
      ready: true,
      problem: null,
      viewer_url: "http://127.0.0.1:5000/vnc.html#password=secret",
      workspace_path: "/Users/person/.openmausbot/vm-homes/private",
      commands: { remove: "docker rm private-container" },
    } as unknown as ContainerComputerStatus;

    const entry = localVmInventoryEntry(
      { id: "bot-1", name: "Research", computer: "cloud" },
      status,
      true,
    );

    expect(entry).toEqual({
      botId: "bot-1",
      name: "Research",
      destination: "cloud",
      container: "running",
      managed: true,
      ready: true,
      problem: null,
      inUse: true,
    });
    expect(JSON.stringify(entry)).not.toMatch(/secret|workspace|command|target/i);
    expect(localVmInventoryEntry(
      { id: "bot-2", name: "Missing" },
      { ...status, container: "missing" } as ContainerComputerStatus,
      false,
    )).toBeNull();
  });

  it("arms idle cleanup only for a running container with verified ownership", () => {
    expect(shouldArmLocalVmIdle({ container: "running", managed: true })).toBe(true);
    expect(shouldArmLocalVmIdle({ container: "running", managed: false })).toBe(false);
    expect(shouldArmLocalVmIdle({ container: "stopped", managed: true })).toBe(false);
    expect(shouldArmLocalVmIdle(null)).toBe(false);
  });
});
