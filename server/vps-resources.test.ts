import { describe, expect, it } from "vitest";

import { normalizeVpsConfig, vpsResources } from "./config.ts";
import { vpsContainerRunArgs } from "./vps-computer.ts";
import { vpsConfigForBot, vpsLimits } from "./vps-hosts.ts";
import { vpsServersSchema } from "./vps-config.ts";

const NAME = "openmausbot-vps-bot-abc123";

describe("VPS desktop resources", () => {
  it("defaults to 4 GB and 2 cores", () => {
    const args = vpsContainerRunArgs(NAME);
    expect(args.slice(args.indexOf("--memory"), args.indexOf("--memory") + 5)).toEqual(["--memory", "4g", "--memory-swap", "4g", "--cpus"]);
    expect(args[args.indexOf("--cpus") + 1]).toBe("2");
  });

  it("applies the configured limits", () => {
    const args = vpsContainerRunArgs(NAME, undefined, undefined, vpsResources({ vps: { sshAlias: "v", memoryGb: 16, cpus: 6 } }));
    expect(args[args.indexOf("--memory") + 1]).toBe("16g");
    expect(args[args.indexOf("--memory-swap") + 1]).toBe("16g");
    expect(args[args.indexOf("--cpus") + 1]).toBe("6");
  });

  it("keeps stored limits when a patch carries only the alias", () => {
    expect(normalizeVpsConfig({ sshAlias: "b" }, { sshAlias: "a", memoryGb: 8, cpus: 3 })).toEqual({ sshAlias: "b", memoryGb: 8, cpus: 3 });
  });

  it("rejects out-of-range or fractional limits", () => {
    expect(() => normalizeVpsConfig({ memoryGb: 1 })).toThrow(/memoryGb/);
    expect(() => normalizeVpsConfig({ cpus: 2.5 })).toThrow(/cpus/);
    expect(() => normalizeVpsConfig({ cpus: 65 })).toThrow(/cpus/);
  });

  describe("named servers", () => {
    const cfg = {
      vps: { sshAlias: "main", memoryGb: 8, cpus: 4 },
      vpsServers: [
        { name: "Lab", sshAlias: "lab", memoryGb: 3, cpus: 2 },
        { name: "Half", sshAlias: "half", cpus: 6 },
        { name: "Plain", sshAlias: "plain" },
      ],
    };

    it("gives a named server its own limits", () => {
      expect(vpsLimits(cfg, "lab")).toEqual({ memoryGb: 3, cpus: 2 });
    });

    it("falls back to the default server's limit for each one a named server leaves out", () => {
      expect(vpsLimits(cfg, "half")).toEqual({ memoryGb: 8, cpus: 6 });
      expect(vpsLimits(cfg, "plain")).toEqual({ memoryGb: 8, cpus: 4 });
    });

    it("uses the default server's limits for the default alias and for an alias that is not listed", () => {
      expect(vpsLimits(cfg, "main")).toEqual({ memoryGb: 8, cpus: 4 });
      expect(vpsLimits(cfg, "elsewhere")).toEqual({ memoryGb: 8, cpus: 4 });
    });

    it("scopes a bot's config to its own server's limits", () => {
      expect(vpsConfigForBot(cfg, { vpsAlias: "lab" })).toEqual({ vps: { sshAlias: "lab", memoryGb: 3, cpus: 2 } });
      expect(vpsConfigForBot(cfg, undefined)).toEqual({ vps: { sshAlias: "main", memoryGb: 8, cpus: 4 } });
    });

    it("accepts whole-number limits in range and refuses the rest", () => {
      expect(vpsServersSchema.safeParse([{ name: "Lab", sshAlias: "lab", memoryGb: 3, cpus: 2 }]).success).toBe(true);
      expect(vpsServersSchema.safeParse([{ name: "Lab", sshAlias: "lab", memoryGb: 1 }]).success).toBe(false);
      expect(vpsServersSchema.safeParse([{ name: "Lab", sshAlias: "lab", cpus: 2.5 }]).success).toBe(false);
    });
  });
});
