import { describe, expect, it } from "vitest";

import { availableToolGroups, toolsOffPart } from "./tool-groups.ts";

describe("tool groups a bot has off", () => {
  it("tells the bot which groups are off and where they come back, and says nothing when none is", () => {
    const part = toolsOffPart({ toolsOff: ["pages", "meetings"] });
    expect(part.id).toBe("tools-off");
    expect(part.text).toContain("Meetings, Pages and apps.");
    expect(part.text).toContain("Settings (Access, Tools)");
    expect(toolsOffPart({ toolsOff: [] }).text).toBe("");
    expect(toolsOffPart({ toolsOff: ["browser"] }).text).toBe("");
    expect(toolsOffPart(undefined).text).toBe("");
  });

  it("offers the groups this workspace has, Pages and apps always", () => {
    expect(availableToolGroups({ meetings: false, data: false, images: false, email: false })).toEqual(["pages"]);
    expect(availableToolGroups({ meetings: true, data: true, images: true, email: true })).toEqual(["meetings", "data", "pages", "images", "email"]);
  });
});
