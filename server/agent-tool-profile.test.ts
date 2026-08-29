import { describe, expect, it } from "vitest";

import { agentsToolProfile } from "./agent-tool-profile.ts";

describe("agentsToolProfile", () => {
  it("keeps the full agents surface on a direct turn", () => {
    expect(agentsToolProfile({ commsDepth: 0, maxCommsDepth: 1, isCaptureOperator: false })).toBe("full");
  });

  it("keeps only capture tools on a delegated Capture turn", () => {
    expect(agentsToolProfile({
      commsDepth: 1,
      maxCommsDepth: 1,
      agent: { agentGrants: [{ capability: "source.ingestion" }] },
    })).toBe("capture");
  });

  it("keeps ordinary delegated turns free of recursive agent tools", () => {
    expect(agentsToolProfile({
      commsDepth: 1,
      maxCommsDepth: 1,
      agent: { name: "renamed collector" },
    })).toBeNull();
  });

  it("retains the boolean adapter for older callers", () => {
    expect(agentsToolProfile({ commsDepth: 1, maxCommsDepth: 1, isCaptureOperator: true })).toBe("capture");
  });
});
