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

  it("refuses more cores or memory than the machine has, with the words' key and params", () => {
    const host = { cpus: 6, memoryBytes: 3.7 * GIB };
    expect(hostLimitProblem("example-host", host, { cpus: 6, memoryGb: 4 })).toBeNull();
    expect(hostLimitProblem("example-host", host, { cpus: 8 })).toEqual({
      error: "example-host has 6 CPU cores in all. Choose 6 or fewer.",
      errorKey: "serverError.vps.tooManyCores",
      errorParams: { server: "example-host", cores: 6 },
    });
    expect(hostLimitProblem("example-host", host, { memoryGb: 6 })?.error).toBe("example-host has about 4 GB of memory. Choose 4 GB or less.");
  });

  it("checks only the limits a save adds or changes, and lets an unreachable host through", async () => {
    const host = vi.fn(async (alias: string) => (alias === "off" ? null : { cpus: 4, memoryBytes: 8 * GIB }));
    const cfg = { vps: { sshAlias: "main", cpus: 2, memoryGb: 4 }, vpsServers: [{ name: "Lab", sshAlias: "lab", cpus: 8, memoryGb: 64 }] };
    expect(await vpsHostLimitProblem(cfg, { vpsServers: cfg.vpsServers }, host)).toBeNull();
    expect(host).not.toHaveBeenCalled();
    expect((await vpsHostLimitProblem(cfg, { vps: { sshAlias: "main", cpus: 5 } }, host))?.error).toBe("main has 4 CPU cores in all. Choose 4 or fewer.");
    expect((await vpsHostLimitProblem(cfg, { vps: { sshAlias: "main", memoryGb: 16 } }, host))?.error).toBe("main has about 8 GB of memory. Choose 8 GB or less.");
    expect((await vpsHostLimitProblem(cfg, { vpsServers: [{ name: "Lab", sshAlias: "lab", cpus: 6, memoryGb: 64 }] }, host))?.errorKey).toBe("serverError.vps.tooManyCores");
    expect(await vpsHostLimitProblem(cfg, { vpsServers: [{ name: "Off", sshAlias: "off", cpus: 64, memoryGb: 128 }] }, host)).toBeNull();
    expect(await vpsHostLimitProblem(cfg, { vps: { sshAlias: "main", cpus: 4, memoryGb: 8 } }, host)).toBeNull();
  });

  it("reads the default server's patch the way the save does: an alias left out clears it", async () => {
    const small = vi.fn(async () => ({ cpus: 1, memoryBytes: 16 * GIB }));
    expect(await vpsHostLimitProblem({ vps: { sshAlias: "main", cpus: 2 } }, { vps: { sshAlias: "" } }, small)).toBeNull();
    expect(await vpsHostLimitProblem({ vps: { sshAlias: "main", cpus: 2 } }, { vps: { cpus: 4 } }, small)).toBeNull();
    expect(small).not.toHaveBeenCalled();
  });

  it("checks a named server that inherits a raised default, asking every host at once", async () => {
    const cfg = { vps: { sshAlias: "main", cpus: 2 }, vpsServers: [{ name: "Small", sshAlias: "small" }] };
    const asked: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const capacity = async (alias: string) => {
      asked.push(alias);
      await gate;
      return alias === "small" ? { cpus: 2, memoryBytes: 16 * GIB } : { cpus: 8, memoryBytes: 16 * GIB };
    };
    const checking = vpsHostLimitProblem(cfg, { vps: { sshAlias: "main", cpus: 4 } }, capacity);
    await Promise.resolve();
    expect(asked.sort()).toEqual(["main", "small"]);
    release();
    expect((await checking)?.error).toContain("small has 2 CPU cores");
  });

  it("checks a new server against the default's limits it inherits", async () => {
    const cfg = { vps: { sshAlias: "main", memoryGb: 16 }, vpsServers: [] };
    const host = async () => ({ cpus: 4, memoryBytes: 8 * GIB });
    expect((await vpsHostLimitProblem(cfg, { vpsServers: [{ name: "Spare", sshAlias: "spare" }] }, host))?.errorKey).toBe("serverError.vps.tooMuchMemory");
  });
});
