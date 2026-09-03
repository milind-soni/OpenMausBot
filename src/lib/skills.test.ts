import { describe, expect, it } from "vitest";

import { clearAcceptedSkill, clearAcceptedSkills, searchSkills, selectedSkillById, selectedSkillsByIds, skillSelectionSummary, skillsCommandQuery, toggleSkillId } from "./skills";

const skills = [
  { id: "phone-harness", name: "Phone Harness", description: "Control an Android phone", origin: "built-in" as const },
  { id: "expense", name: "File expense", description: "Submit a reviewed expense", origin: "recorded" as const },
  { id: "review-pr", name: "Review PR", description: "Review pull requests", origin: "imported" as const, source: "org/skills" },
];

describe("skills composer helpers", () => {
  it("recognizes only the local /skills command and keeps its search query", () => {
    expect(skillsCommandQuery("/skills")).toBe("");
    expect(skillsCommandQuery("  /skills phone  ")).toBe("phone");
    expect(skillsCommandQuery("please /skills")).toBeNull();
    expect(skillsCommandQuery("/skill")).toBeNull();
  });

  it("searches stable catalog metadata and resolves one exact selection", () => {
    expect(searchSkills(skills, "recorded expense").map((skill) => skill.id)).toEqual(["expense"]);
    expect(searchSkills(skills, "org review").map((skill) => skill.id)).toEqual(["review-pr"]);
    expect(selectedSkillById(skills, "phone-harness")?.name).toBe("Phone Harness");
    expect(selectedSkillById(skills, "missing")).toBeNull();
  });

  it("clears only the exact skill whose send was accepted", () => {
    expect(clearAcceptedSkill("expense", "expense")).toBeNull();
    expect(clearAcceptedSkill("phone-harness", "expense")).toBe("phone-harness");
    expect(clearAcceptedSkill("expense", undefined)).toBe("expense");
  });

  it("keeps multi-selection ordered, unique, bounded, and clears only accepted ids", () => {
    expect(toggleSkillId(["expense"], "review-pr")).toEqual(["expense", "review-pr"]);
    expect(toggleSkillId(["expense", "review-pr"], "expense")).toEqual(["review-pr"]);
    expect(toggleSkillId(Array.from({ length: 8 }, (_, index) => `skill-${index}`), "ninth")).toHaveLength(8);
    expect(selectedSkillsByIds(skills, ["review-pr", "phone-harness"]).map((skill) => skill.id)).toEqual(["review-pr", "phone-harness"]);
    expect(clearAcceptedSkills(["phone-harness", "expense"], ["expense"])).toEqual(["phone-harness"]);
  });

  it("states available, selected, and per-send maximum separately", () => {
    expect(skillSelectionSummary(3, 2)).toBe("3 available · 2 selected · max 8 per send");
  });
});
