import { describe, expect, it } from "vitest";

import type { HostMemory } from "./engine-memory.ts";
import { createMachinePressure, PRESSURE_READ_MS, SMALL_MEMORY_BYTES } from "./machine-pressure.ts";

const GB = 1024 ** 3;
const calm: HostMemory = { totalBytes: 2 * GB, availableBytes: GB, swapFreeBytes: 0, oomKills: 0, fullStall10: 0 };
const psi = (some: number) => `some avg10=${some} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n`;
const stat = (total: number, steal: number) => `cpu  ${total - steal} 0 0 0 0 0 0 ${steal} 0 0\ncpu0 1 2 3\n`;

function machine(files: Record<string, string>, more: Partial<Parameters<typeof createMachinePressure>[0]> = {}) {
  let at = 1_000_000;
  const pressure = createMachinePressure({
    enabled: () => true, read: (path) => files[path] ?? null, memory: () => calm, loopDelayMs: () => 0, now: () => at, cpus: () => 4, ...more,
  });
  return { pressure, later: (ms: number) => { at += ms; } };
}

describe("machine pressure", () => {
  it("reads calm on a quiet machine", () => {
    const { pressure } = machine({ "/proc/pressure/cpu": psi(3) });
    expect(pressure.reason()).toBeNull();
    expect(pressure.pressed()).toBe(false);
  });

  it("the memory stall the starved Cloud showed presses it", () => {
    const { pressure } = machine({}, { memory: () => ({ ...calm, fullStall10: 10.4 }) });
    expect(pressure.reason()).toBe("memory stall 10.4%");
  });

  it("CPU pressure, the cgroup's own first, presses it", () => {
    expect(machine({ "/proc/pressure/cpu": psi(72) }).pressure.reason()).toBe("cpu stall 72%");
    expect(machine({ "/sys/fs/cgroup/cpu.pressure": psi(64), "/proc/pressure/cpu": psi(1) }).pressure.reason()).toBe("cpu stall 64%");
  });

  it("steal and cgroup throttling between two readings press it", () => {
    const files: Record<string, string> = { "/proc/stat": stat(10_000, 0), "/sys/fs/cgroup/cpu.stat": "usage_usec 1\nthrottled_usec 0\n" };
    const { pressure, later } = machine(files);
    expect(pressure.reason()).toBeNull();
    files["/proc/stat"] = stat(10_400, 200);
    later(PRESSURE_READ_MS);
    expect(pressure.reason()).toBe("cpu steal 50%");
    files["/proc/stat"] = stat(10_800, 210);
    files["/sys/fs/cgroup/cpu.stat"] = "usage_usec 1\nthrottled_usec 3000000\n";
    later(PRESSURE_READ_MS);
    expect(pressure.reason()).toBe("cpu throttled 60%");
  });

  it("an event loop held for seconds presses it", () => {
    expect(machine({}, { loopDelayMs: () => 11_000 }).pressure.reason()).toBe("event loop delayed 11s");
  });

  it("answers from its last reading for a few seconds", () => {
    let stall = 0;
    const { pressure, later } = machine({}, { memory: () => ({ ...calm, fullStall10: stall }) });
    expect(pressure.pressed()).toBe(false);
    stall = 30;
    expect(pressure.pressed()).toBe(false);
    later(PRESSURE_READ_MS);
    expect(pressure.pressed()).toBe(true);
  });

  it("never reads pressed or small where turns do not wait for room (the desktop app)", () => {
    const { pressure } = machine({ "/proc/pressure/cpu": psi(99) }, { enabled: () => false });
    expect(pressure.pressed()).toBe(false);
    expect(pressure.small()).toBe(false);
  });

  it("a 2 GB Cloud or two CPUs is small", () => {
    expect(machine({}).pressure.small()).toBe(true);
    expect(machine({}, { memory: () => ({ ...calm, totalBytes: SMALL_MEMORY_BYTES * 2 }) }).pressure.small()).toBe(false);
    expect(machine({}, { memory: () => ({ ...calm, totalBytes: SMALL_MEMORY_BYTES * 2 }), cpus: () => 2 }).pressure.small()).toBe(true);
  });
});
