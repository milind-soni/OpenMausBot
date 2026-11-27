import { describe, expect, it } from "vitest";

import { createLocalVmAvailability } from "./local-vm-availability.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("whether this server can give a bot a Local VM", () => {
  it("says no when the host has no container runtime to run one", async () => {
    const availability = createLocalVmAvailability(async () => ({ available: [] }));
    expect(availability.available()).toBe(true);
    await flush();
    expect(availability.available()).toBe(false);
  });

  it("says yes when the runtime is installed but its daemon is down, since a turn starts it", async () => {
    const availability = createLocalVmAvailability(async () => ({ available: ["podman"], daemonUp: false }));
    await flush();
    expect(availability.available()).toBe(true);
  });

  it("reads it again at most once a minute while the answer is no, so a runtime installed later shows up", async () => {
    let clock = 0;
    let runtimes: string[] = [];
    let probes = 0;
    const availability = createLocalVmAvailability(async () => { probes += 1; return { available: runtimes }; }, () => clock);
    await flush();
    expect(availability.available()).toBe(false);
    runtimes = ["docker"];
    clock = 59_999;
    expect(availability.available()).toBe(false);
    expect(probes).toBe(1);
    clock = 60_000;
    availability.available();
    await flush();
    expect(probes).toBe(2);
    expect(availability.available()).toBe(true);
  });

  it("says yes when a runtime is installed and its daemon answers", async () => {
    const availability = createLocalVmAvailability(async () => ({ available: ["docker"], daemonUp: true }));
    await flush();
    expect(availability.available()).toBe(true);
  });

  it("keeps the tool listed when the probe fails", async () => {
    const availability = createLocalVmAvailability(async () => { throw new Error("no runtime"); });
    await flush();
    expect(availability.available()).toBe(true);
  });

  it("keeps the tool listed when the probe answers without a runtime list", async () => {
    const availability = createLocalVmAvailability(async () => ({ daemonUp: true }));
    await flush();
    expect(availability.available()).toBe(true);
  });

  it("starts its first read at once, so the first turn already lists the tools every later turn lists", async () => {
    let probes = 0;
    const availability = createLocalVmAvailability(async () => { probes += 1; return { available: [] }; });
    expect(probes).toBe(1);
    await flush();
    const turns = [availability.available(), availability.available()];
    expect(turns).toEqual([false, false]);
  });
});
