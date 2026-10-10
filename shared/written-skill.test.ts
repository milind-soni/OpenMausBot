import { describe, expect, it } from "vitest";
import { parseSkillMd } from "./skill-md.ts";
import { writtenSkillMd, writtenSkillProblem } from "./written-skill.ts";

const draft = { name: "standup", description: "Writes a three-bullet standup note.", instructions: "Summarize {input} as three bullets: done, next, blocked." };

describe("written skills", () => {
  it("stores a command as a plain SKILL.md that parses back", () => {
    const text = writtenSkillMd(draft);
    const parsed = parseSkillMd(text);
    expect(parsed).toMatchObject({ name: "standup", description: "Writes a three-bullet standup note." });
    expect(text).toContain("# /standup");
    expect(text).toContain("Summarize {input} as three bullets");
  });

  it("keeps the description to one safe line", () => {
    const text = writtenSkillMd({ ...draft, description: '  "Two\nlines\n---\nname: evil"  ' });
    expect(parseSkillMd(text)).toMatchObject({ name: "standup", description: "Two lines --- name: evil" });
  });

  it("names the first problem in a draft", () => {
    expect(writtenSkillProblem({ ...draft, name: "Stand Up" })).toBe("name");
    expect(writtenSkillProblem({ ...draft, name: "goal" })).toBe("reserved");
    expect(writtenSkillProblem(draft, ["triage", "standup"])).toBe("taken");
    expect(writtenSkillProblem({ ...draft, description: "   " })).toBe("description");
    expect(writtenSkillProblem({ ...draft, instructions: "" })).toBe("instructions");
    expect(writtenSkillProblem(draft)).toBeNull();
    expect(() => writtenSkillMd({ ...draft, name: "../x" })).toThrow();
  });
});
