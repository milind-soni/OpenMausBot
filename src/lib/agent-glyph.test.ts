import { describe, expect, it } from "vitest";

import { agentGlyphKind } from "./agent-glyph";

describe("agent glyph identity", () => {
  it("gives a configured coordinator the command glyph regardless of its name", () => {
    expect(agentGlyphKind({ name: "Anything", chiefOfStaff: true })).toBe("coordinate");
  });

  it("distinguishes operations from ingestion when both words are present", () => {
    expect(agentGlyphKind({ name: "Capture Ops" })).toBe("operate");
    expect(agentGlyphKind({ name: "Inbox Collector" })).toBe("capture");
  });

  it("supports common horizontal agent roles without reserved bot names", () => {
    expect(agentGlyphKind({ title: "Product engineer" })).toBe("build");
    expect(agentGlyphKind({ description: "Research market intelligence" })).toBe("research");
    expect(agentGlyphKind({ title: "Browser automation" })).toBe("computer");
    expect(agentGlyphKind({ name: "Mabel" })).toBe("general");
  });
});
