import { describe, expect, it } from "vitest";

import { appliesNow, directApply } from "./direct-apply.ts";

describe("appliesNow", () => {
  it("applies at Full access and at every other level, with no card of OpenMausBot's own", () => {
    expect(appliesNow({ fullAccess: true, ownerMustConfirm: false })).toBe("full-access");
    expect(appliesNow({ fullAccess: false, ownerMustConfirm: false })).toBe("level");
  });

  it("waits for the owner only in a Cloud turn the owner did not drive", () => {
    expect(appliesNow({ fullAccess: false, ownerMustConfirm: true })).toBeNull();
  });
});

describe("directApply (routine requests)", () => {
  it("applies everything at Full access, unchanged", () => {
    expect(directApply({ fullAccess: true, botId: "a", targetBotId: "b", blocked: false })).toBe("full-access");
    expect(directApply({ fullAccess: true, botId: "a", targetBotId: "a", blocked: false })).toBe("full-access");
  });

  it("applies a bot's change to itself at any other level", () => {
    expect(directApply({ fullAccess: false, botId: "a", targetBotId: "a", blocked: false })).toBe("self");
  });

  it("keeps the card for another bot, and for everything in a guest-driven turn", () => {
    expect(directApply({ fullAccess: false, botId: "a", targetBotId: "b", blocked: false })).toBeNull();
    expect(directApply({ fullAccess: false, botId: "a", targetBotId: "a", blocked: true })).toBeNull();
  });
});
