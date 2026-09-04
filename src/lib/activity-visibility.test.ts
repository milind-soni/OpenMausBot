import { describe, expect, it } from "vitest";

import { activityChipVisible } from "./activity-visibility";

describe("activityChipVisible", () => {
  it("hides plain tool runs unless tool calls are on", () => {
    expect(activityChipVisible({ tool: { name: "Read", ok: true } }, false)).toBe(false);
    expect(activityChipVisible({ tool: { name: "Read", ok: true } }, true)).toBe(true);
    expect(activityChipVisible({ tool: { name: "Read" } }, false)).toBe(false);
  });

  it("always shows a failure and a comm chip", () => {
    expect(activityChipVisible({ tool: { name: "memory: over budget — 37 lines did not load", ok: false } }, false)).toBe(true);
    expect(
      activityChipVisible({ comm: { groupId: "g", withBotId: "b", withName: "Scout", withColor: "green" } }, false),
    ).toBe(true);
  });
});
