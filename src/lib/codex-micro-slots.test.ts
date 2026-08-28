import { describe, expect, it } from "vitest";

import { botCodexStatus, codexMicroRoster, codexMicroSlotBots } from "./codex-micro-slots";

describe("codexMicroSlotBots", () => {
  it("puts the unsectioned chief first, then pinned bots, then the rest", () => {
    const slots = codexMicroSlotBots([
      { id: "anchor", name: "Anchor", section: "Agents" },
      { id: "forge", name: "Forge", pinned: true, section: "Agents" },
      { id: "trace", name: "Trace", chiefOfStaff: true },
      { id: "vera", name: "Vera" },
    ]);
    expect(slots.map((bot) => bot.id)).toEqual(["trace", "forge", "vera", "anchor"]);
  });
});

describe("codexMicroRoster", () => {
  it("maps activity onto the deck status vocabulary", () => {
    expect(botCodexStatus({ activity: "working" })).toBe("working");
    expect(botCodexStatus({ activity: "waiting-on-you" })).toBe("needsYou");
    expect(botCodexStatus({ busy: true })).toBe("working");
    expect(
      codexMicroRoster([{ id: "trace", name: "Trace", chiefOfStaff: true, activity: "idle" }]).agents,
    ).toEqual([{ id: "trace", name: "Trace", status: "ready" }]);
  });
});
