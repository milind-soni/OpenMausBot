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

  it("says no when the runtime is installed but its daemon is down", async () => {
    const availability = createLocalVmAvailability(async () => ({ available: ["docker"], daemonUp: false }));
    await flush();
    expect(availability.available()).toBe(false);
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
});
