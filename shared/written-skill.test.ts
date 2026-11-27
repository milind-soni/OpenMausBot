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

  it("double-quotes a description containing a colon+space so the frontmatter stays valid YAML", () => {
    const text = writtenSkillMd({ ...draft, description: "Show me your work: evidence, not vibes." });
    expect(text.split("\n")[2]).toBe('description: "Show me your work: evidence, not vibes."');
    expect(parseSkillMd(text)).toMatchObject({ description: "Show me your work: evidence, not vibes." });
  });

  it("escapes double quotes inside a description and reads them back", () => {
    const text = writtenSkillMd({ ...draft, description: 'Show the "receipt", not the promise' });
    expect(text.split("\n")[2]).toBe('description: "Show the \\"receipt\\", not the promise"');
    expect(parseSkillMd(text)).toMatchObject({ description: 'Show the "receipt", not the promise' });
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
