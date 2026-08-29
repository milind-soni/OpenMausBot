import { describe, expect, it } from "vitest";

import { agentProfileSummary } from "./agent-profile-summary.ts";

describe("agentProfileSummary", () => {
  it("projects safe counts from canonical stores and ignores another agent's rules", () => {
    const summary = agentProfileSummary({
      botId: "chief",
      generatedAt: 5_000,
      activeWorldClaims: 12,
      latestWorldObservationAt: 4_100,
      legacyAllowedTools: ["read_file", "read_file", "grep"],
      accountBindingCount: 2,
      work: {
        obligations: [{ updatedAt: 4_700 }, { updatedAt: 4_800 }],
      },
      rules: [
        { ownerId: "chief", approvedAt: 4_900, createdAt: 4_000 },
        { ownerId: "research", approvedAt: 4_950, createdAt: 4_100 },
      ],
    });
    expect(summary).toEqual({
      generatedAt: 5_000,
      identityAndPreferences: 12,
      standingRules: 3,
      openWork: 2,
      accountBindings: 2,
      lastUpdatedAt: 4_900,
    });
  });

  it("returns null freshness when no canonical store has data", () => {
    expect(agentProfileSummary({
      botId: "new",
      generatedAt: 10,
      activeWorldClaims: 0,
      latestWorldObservationAt: null,
      legacyAllowedTools: [],
      accountBindingCount: 0,
      work: { obligations: [] },
      rules: [],
    }).lastUpdatedAt).toBeNull();
  });
});
