import { describe, expect, it, vi } from "vitest";

import { hostLimitProblem, vpsHostCapacity, vpsHostLimitProblem } from "./vps-host-limits.ts";

const GIB = 1024 ** 3;

describe("VPS host limits", () => {
  it("asks the host's Docker engine for its CPUs and memory, and says null when it cannot", async () => {
    const run = vi.fn(async () => ({ stdout: "6 8000000000\n", stderr: "" }));
    expect(await vpsHostCapacity("example-host", run)).toEqual({ cpus: 6, memoryBytes: 8_000_000_000 });
    expect(run).toHaveBeenCalledWith(["-H", "ssh://example-host", "info", "--format", "{{.NCPU}} {{.MemTotal}}"], { timeoutMs: 20_000 });
    expect(await vpsHostCapacity("example-host", async () => { throw new Error("down"); })).toBeNull();
    expect(await vpsHostCapacity("example-host", async () => ({ stdout: "x", stderr: "" }))).toBeNull();
  });

  it("refuses more cores or memory than the machine has, and pins to CPUs it does not have", () => {
    const host = { cpus: 6, memoryBytes: 3.7 * GIB };
    expect(hostLimitProblem("example-host", host, { cpus: 6, cpuset: "0-5", memoryGb: 4 })).toBeNull();
    expect(hostLimitProblem("example-host", host, { cpus: 8 })).toBe("example-host has 6 CPU cores, so 8 cores can't be set");
    expect(hostLimitProblem("example-host", host, { cpuset: "4-7" })).toBe("example-host has CPUs 0-5, so CPU pinning 4-7 can't be set");
    expect(hostLimitProblem("example-host", host, { memoryGb: 6 })).toBe("example-host has 3.7 GB of memory, so 6 GB can't be set");
    expect(hostLimitProblem("example-host", { cpus: 1, memoryBytes: 4 * GIB }, { cpus: 2 })).toBe("example-host has 1 CPU core, so 2 cores can't be set");
  });

  it("checks only the limits a save adds or changes, once per host, and lets an unreachable host through", async () => {
    const host = vi.fn(async (alias: string) => (alias === "off" ? null : { cpus: 4, memoryBytes: 8 * GIB }));
    const cfg = { vps: { sshAlias: "main", cpus: 2, memoryGb: 4 }, vpsServers: [{ name: "Lab", sshAlias: "lab", cpus: 8, memoryGb: 64 }] };
    expect(await vpsHostLimitProblem(cfg, { vpsServers: cfg.vpsServers }, host)).toBeNull();
    expect(host).not.toHaveBeenCalled();
    expect(await vpsHostLimitProblem(cfg, { vps: { cpus: 5 } }, host)).toBe("main has 4 CPU cores, so 5 cores can't be set");
    expect(await vpsHostLimitProblem(cfg, { vps: { memoryGb: 16 } }, host)).toBe("main has 8.0 GB of memory, so 16 GB can't be set");
    expect(await vpsHostLimitProblem(cfg, { vpsServers: [{ name: "Lab", sshAlias: "lab", cpus: 8, memoryGb: 64, cpuset: "0-1" }] }, host)).toBe("lab has 4 CPU cores, so 8 cores can't be set");
    expect(await vpsHostLimitProblem(cfg, { vpsServers: [{ name: "Off", sshAlias: "off", cpus: 64, memoryGb: 128 }] }, host)).toBeNull();
    expect(await vpsHostLimitProblem(cfg, { vps: { cpus: 4, memoryGb: 8, cpuset: "0-3" } }, host)).toBeNull();
    expect(host).toHaveBeenCalledTimes(5);
  });
});
