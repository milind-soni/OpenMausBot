import { describe, expect, it } from "vitest";
import { meetingsUnavailablePrompt, MEETINGS_NEED_CLOUD_COMPUTER } from "./prompt.ts";

describe("what a bot is told when meeting notes can't run here (email 1a1bc66c)", () => {
  it("without a cloud computer it is told why it has no meeting tools and what fixes it", () => {
    const prompt = meetingsUnavailablePrompt({ agentsTools: true, cloudComputer: false });
    expect(prompt).toContain("no meeting tools");
    expect(prompt).toContain(MEETINGS_NEED_CLOUD_COMPUTER);
    expect(prompt).toContain("Settings → Computers");
  });
  it("says nothing with a cloud computer, or to a bot without the agents tools", () => {
    expect(meetingsUnavailablePrompt({ agentsTools: true, cloudComputer: true })).toBe("");
    expect(meetingsUnavailablePrompt({ agentsTools: false, cloudComputer: false })).toBe("");
  });
});
