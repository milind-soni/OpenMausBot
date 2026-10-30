import { describe, expect, it } from "vitest";

import { vpsAliasesInPlay, vpsConfigForBot, vpsSshAliasForBot } from "./vps-hosts.ts";

describe("which VPS host a bot uses", () => {
  it("lets a bot's own alias win, falls back to the default for an invalid or missing one, and invents nothing", () => {
    expect(vpsSshAliasForBot({ vps: { sshAlias: "production-vps" } }, { vpsAlias: "alpha-vps" })).toBe("alpha-vps");
    expect(vpsSshAliasForBot({}, { vpsAlias: "alpha-vps" })).toBe("alpha-vps");
    expect(vpsSshAliasForBot({ vps: { sshAlias: "production-vps" } }, { vpsAlias: "-bad" })).toBe("production-vps");
    expect(vpsSshAliasForBot({ vps: { sshAlias: "production-vps" } }, null)).toBe("production-vps");
    expect(vpsSshAliasForBot({}, {})).toBeNull();
    expect(vpsConfigForBot({ vps: { sshAlias: "production-vps" } }, { vpsAlias: "alpha-vps" })).toEqual({ vps: { sshAlias: "alpha-vps" } });
    expect(vpsConfigForBot({}, {})).toEqual({});
  });

  it("puts every server in play in the inventory once, the default first", () => {
    expect(vpsAliasesInPlay(
      { vps: { sshAlias: "production-vps" } },
      [{}, { vpsAlias: "alpha-vps" }, { vpsAlias: "production-vps" }, { vpsAlias: "bad alias" }],
    )).toEqual(["production-vps", "alpha-vps"]);
    expect(vpsAliasesInPlay({}, [{ vpsAlias: "alpha-vps" }])).toEqual(["alpha-vps"]);
    expect(vpsAliasesInPlay({}, [{}])).toEqual([]);
  });
});
