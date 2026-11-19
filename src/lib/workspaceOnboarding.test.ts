import { describe, expect, it } from "vitest";
import { parseTeamProposal, proposeTeam } from "./workspaceOnboarding";

describe("proposeTeam", () => {
  it("writes detailed Role / Personality & Task / Rules instructions for every Buddy", () => {
    const team = proposeTeam(["Development", "Design", "Research", "Finance"], "", null);
    expect(team.map((buddy) => buddy.title)).toEqual([
      "Project Lead",
      "Developer",
      "Product Designer",
      "Research Analyst",
      "Finance Analyst",
      "Reviewer",
    ]);
    for (const buddy of team) {
      expect(buddy.description).toMatch(/^Role: You are the /);
      expect(buddy.description).toContain("\nPersonality & Task: ");
      expect(buddy.description).toContain("\nRules:\n- ");
      expect(buddy.description.split("\n").filter((line) => line.startsWith("- ")).length).toBeGreaterThanOrEqual(4);
      expect(buddy.description.length).toBeGreaterThan(450);
      expect(buddy.description.length).toBeLessThanOrEqual(2400);
    }
  });

  it("anchors the lead and workflow specialist to the custom goal", () => {
    const team = proposeTeam(["Custom"], "Plan a product launch", { instanceId: "claude", model: "sonnet" });
    expect(team[0].description).toContain("Plan a product launch");
    expect(team.find((buddy) => buddy.title === "Workflow Specialist")?.description).toContain("Plan a product launch");
    expect(team.every((buddy) => buddy.modelSelection?.instanceId === "claude")).toBe(true);
  });
});

describe("parseTeamProposal", () => {
  const generated = proposeTeam(["Custom"], "Review accessible forms", null)
    .map(({ name, title, reason, description }) => ({ name, title, reason, description }));

  it("adds local IDs and the chosen model to validated suggestions", () => {
    const model = { instanceId: "claude", model: "sonnet" };
    const result = parseTeamProposal({ team: generated }, model);
    expect(result).toEqual(generated.map((buddy) => ({ ...buddy, id: expect.any(String), modelSelection: model })));
    expect(new Set(result.map((buddy) => buddy.id)).size).toBe(result.length);
  });

  it("rejects malformed response data and unstructured instructions", () => {
    for (const response of [null, { team: "invalid" }, { team: [{ ...generated[0], description: "Help." }, ...generated.slice(1)] }]) {
      expect(() => parseTeamProposal(response, null)).toThrow("invalid team proposal");
    }
  });
});
