import { describe, expect, it } from "vitest";

import { cpusetSize, isValidCpuset, resourceArgs } from "./container-limits.ts";
import { normalizeVpsConfig, vpsServersSchema } from "./vps-config.ts";
import { vpsLimits } from "./vps-hosts.ts";

describe("CPU pinning", () => {
  it("accepts CPU ids and ranges and refuses anything else", () => {
    for (const ok of ["0", "0,2", "4-7", "0-1,4,6-7"]) expect(isValidCpuset(ok)).toBe(true);
    for (const bad of ["", "a", "7-4", "0,", "1 2", "0-", "--1", "0;rm"]) expect(isValidCpuset(bad)).toBe(false);
  });

  it("passes --cpuset-cpus to the container only when pinned", () => {
    expect(resourceArgs({ memoryGb: 4, cpus: 2 }, { swap: true })).not.toContain("--cpuset-cpus");
    expect(resourceArgs({ memoryGb: 4, cpus: 2, cpuset: "4-7" }, { swap: true }).slice(-2)).toEqual(["--cpuset-cpus", "4-7"]);
  });

  it("stores the default server's pinning, keeps it when a patch leaves it out, and clears it with an empty string", () => {
    expect(normalizeVpsConfig({ sshAlias: "a", cpuset: "0,2" })).toEqual({ sshAlias: "a", cpuset: "0,2" });
    expect(normalizeVpsConfig({ sshAlias: "a" }, { cpuset: "0,2" })).toEqual({ sshAlias: "a", cpuset: "0,2" });
    expect(normalizeVpsConfig({ sshAlias: "a", cpuset: "" }, { cpuset: "0,2" })).toEqual({ sshAlias: "a" });
    expect(() => normalizeVpsConfig({ sshAlias: "a", cpuset: "9-1" })).toThrow(/cpuset/);
  });

  it("counts the CPUs a pinning names and refuses one above the cores", () => {
    expect([cpusetSize("0"), cpusetSize("0,2"), cpusetSize("4-7"), cpusetSize("0-1,4,6-7")]).toEqual([1, 2, 4, 5]);
    expect(normalizeVpsConfig({ sshAlias: "a", cpus: 4, cpuset: "0-3" })).toEqual({ sshAlias: "a", cpus: 4, cpuset: "0-3" });
    expect(() => normalizeVpsConfig({ sshAlias: "a", cpus: 4, cpuset: "0-4" })).toThrow(/5 CPUs but vps.cpus is 4/);
    expect(() => normalizeVpsConfig({ sshAlias: "a", cpuset: "0-2" })).toThrow(/3 CPUs but vps.cpus is 2/);
    expect(vpsServersSchema.safeParse([{ name: "Lab", sshAlias: "lab", cpus: 4, cpuset: "0-4" }]).success).toBe(false);
    expect(vpsServersSchema.safeParse([{ name: "Lab", sshAlias: "lab", cpus: 4, cpuset: "0-3" }]).success).toBe(true);
  });

  it("refuses a bad pinning on a named server", () => {
    expect(vpsServersSchema.safeParse([{ name: "Lab", sshAlias: "lab", cpuset: "4-7" }]).success).toBe(true);
    expect(vpsServersSchema.safeParse([{ name: "Lab", sshAlias: "lab", cpuset: "x" }]).success).toBe(false);
  });

  it("never lends the default server's pinning to a named server", () => {
    const cfg = { vps: { sshAlias: "main", memoryGb: 6, cpus: 3, cpuset: "0-1" }, vpsServers: [{ name: "Lab", sshAlias: "lab" }, { name: "Pinned", sshAlias: "pin", cpuset: "2" }] };
    expect(vpsLimits(cfg, "main")).toEqual({ memoryGb: 6, cpus: 3, cpuset: "0-1" });
    expect(vpsLimits(cfg, "lab")).toEqual({ memoryGb: 6, cpus: 3 });
    expect(vpsLimits(cfg, "pin")).toEqual({ memoryGb: 6, cpus: 3, cpuset: "2" });
  });
});
