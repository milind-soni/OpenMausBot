import { describe, expect, it } from "vitest";

import { renderRoleOverlayInstructions, suggestRoleOverlays } from "./role-overlays.ts";

describe("portfolio role overlays", () => {
  it("selects the smallest relevant specialist set", () => {
    expect(suggestRoleOverlays("Fix the SwiftUI iPhone layout and verify it in Xcode").map((row) => row.id)).toEqual([
      "ios-engineer",
      "qa-acceptance",
    ]);
  });

  it("keeps role overlays advisory and capability-lazy", () => {
    const prompt = renderRoleOverlayInstructions("Close the GitHub PR without losing a dirty worktree");
    expect(prompt).toContain("guidance only; no added authority");
    expect(prompt).toContain("Source Closeout");
    expect(prompt).not.toContain("api key");
  });

  it("adds nothing to unrelated conversation", () => {
    expect(renderRoleOverlayInstructions("Tell me a short joke")).toBe("");
  });
});
