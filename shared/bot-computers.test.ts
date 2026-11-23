import { describe, expect, it } from "vitest";

import { vpsAliasOfServerId, vpsServerId } from "./bot-computers.ts";

describe("VPS server ids", () => {
  it("round-trips an alias through its vps:<alias> server id", () => {
    expect(vpsServerId("office-vps")).toBe("vps:office-vps");
    expect(vpsAliasOfServerId(vpsServerId("office-vps"))).toBe("office-vps");
  });

  it("reads no alias from a container id, another kind's id or a malformed one", () => {
    for (const id of ["vps:office-vps/openmausbot-vps-bot-abc", "cloud:bot-1", "local", "vps:", "vps:-x", "office-vps"]) {
      expect(vpsAliasOfServerId(id)).toBeNull();
    }
  });
});
