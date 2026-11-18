import { describe, expect, it } from "vitest";

import { availableTools, type CatalogProfile } from "./agents-catalog.ts";

const PROFILE: CatalogProfile = {
  skillAuthoring: false, sharedComputers: false, voiceNotes: false, cloudHome: false, chief: false, botId: "bot-scout",
};

describe("the Local VM's tools", () => {
  it("are not listed on a server that cannot give a bot a Local VM", () => {
    expect(availableTools({ ...PROFILE, localVm: false }).map((tool) => tool.name)).not.toContain("vm_exec");
  });

  it("are listed when it can", () => {
    expect(availableTools({ ...PROFILE, localVm: true }).map((tool) => tool.name)).toContain("vm_exec");
  });

  it("are listed when the server does not say", () => {
    expect(availableTools(PROFILE).map((tool) => tool.name)).toContain("vm_exec");
  });

  it("are not offered as a place to pick either", () => {
    const surfaces = (profile: CatalogProfile) => {
      const tool = availableTools({ ...profile, computerSelection: true }).find((candidate) => candidate.name === "select_computer");
      const properties = (tool?.inputSchema as { properties?: { surface?: { enum?: string[] } } } | undefined)?.properties;
      return properties?.surface?.enum ?? [];
    };
    expect(surfaces({ ...PROFILE, localVm: false })).not.toContain("vm");
    expect(surfaces({ ...PROFILE, localVm: false })).toContain("auto");
    expect(surfaces({ ...PROFILE, localVm: true })).toContain("vm");
  });
});
