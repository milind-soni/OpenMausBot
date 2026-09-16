// Phase 4 part 3: post-task reflection into a candidate skill — the prompt,
// the strict parse of the draft, the four required sections, and the rule
// for when a task is worth reflecting on.
import { describe, expect, it } from "vitest";
import { parseSkillDraft, reflectionPrompt, worthReflecting } from "./reflection.ts";

describe("when to reflect", () => {
  it("only on a task judged complete with enough tool steps", () => {
    expect(worthReflecting({ judgedComplete: true, toolSteps: 3 })).toBe(true);
    expect(worthReflecting({ judgedComplete: true, toolSteps: 2 })).toBe(false);
    expect(worthReflecting({ judgedComplete: false, toolSteps: 9 })).toBe(false);
  });
});

describe("the prompt", () => {
  it("carries the task, what happened and the four sections it wants back", () => {
    const prompt = reflectionPrompt({ title: "Add a greeting", body: "Create greeting.txt containing hello", result: "[digest] · tools: Write ×1", botSaid: ["Created greeting.txt"], activities: ["Write greeting.txt", "Bash: npm test"] });
    expect(prompt).toContain("You are the REFLECTOR");
    expect(prompt).toContain("Create greeting.txt containing hello");
    expect(prompt).toContain("Bash: npm test");
    for (const section of ["When to use", "Procedure", "Pitfalls", "Verification"]) expect(prompt).toContain(section);
    expect(prompt).toMatch(/NONE/);
  });
});

describe("parsing the draft", () => {
  const good = JSON.stringify({ name: "Greeting File", description: "Write a greeting file and prove it with the test", skill_md: "# Greeting file\n\n## When to use\nWhen asked for greeting.txt.\n\n## Procedure\n1. Write the file.\n\n## Pitfalls\nDo not change the requested word.\n\n## Verification\nRun npm test." });
  it("reads name, description and the skill file; the name becomes a kebab id", () => {
    const draft = parseSkillDraft(good)!;
    expect(draft.name).toBe("greeting-file");
    expect(draft.description).toMatch(/greeting file/i);
    expect(draft.skillMd).toMatch(/^---\nname: greeting-file\ndescription: /);
    expect(draft.skillMd).toContain("## Verification");
  });
  it("refuses NONE, prose, a missing section, and an empty procedure", () => {
    expect(parseSkillDraft("NONE")).toBeNull();
    expect(parseSkillDraft("I would not make a skill of this.")).toBeNull();
    expect(parseSkillDraft(JSON.stringify({ name: "x", description: "d", skill_md: "## When to use\nx\n## Procedure\n1. y" }))).toBeNull();
    expect(parseSkillDraft(JSON.stringify({ name: "x", description: "d", skill_md: "## When to use\nx\n## Procedure\n\n## Pitfalls\np\n## Verification\nv" }))).toBeNull();
  });
});
