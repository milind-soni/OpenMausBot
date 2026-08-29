import { describe, expect, it } from "vitest";

import { parseAgentProfileSummary, relativeProfileFreshness } from "./agent-profile-summary";

describe("agent profile summary", () => {
  it("validates the compact canonical projection", () => {
    expect(parseAgentProfileSummary({
      generatedAt: 10,
      identityAndPreferences: 12,
      standingRules: 8,
      openWork: 6,
      accountBindings: 3,
      lastUpdatedAt: 9,
    })).toMatchObject({ identityAndPreferences: 12, standingRules: 8, openWork: 6 });
    expect(parseAgentProfileSummary({ generatedAt: 10, openWork: -1 })).toBeNull();
  });

  it("renders freshness without pretending an empty store was updated", () => {
    expect(relativeProfileFreshness(null, 10_000)).toBe("Not populated yet");
    expect(relativeProfileFreshness(9_000, 10_000)).toBe("Updated just now");
    expect(relativeProfileFreshness(10_000, 10_000 + 125 * 60_000)).toBe("Updated 2h ago");
  });
});
