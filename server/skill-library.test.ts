import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadBundledSkills, loadUserSkills, mergeSkills, parseSkillManifest, renderSkillInstructions, selectBundledSkills, type BundledSkill } from "./skill-library.ts";

const instructionsFor = (text: string, capabilities: string[], skills: BundledSkill[], options?: { includeRoot?: boolean }) =>
  renderSkillInstructions(selectBundledSkills(text, capabilities, skills), options);

const phone: BundledSkill = {
  directory: "/skills/phone-harness",
  instructions: "---\nname: phone-harness\ndescription: test\n---\nUse phone tools.",
  manifest: {
    id: "phone-harness",
    name: "Phone Harness",
    version: "0.1.0",
    description: "Control a phone",
    defaultEnabled: true,
    triggerTerms: ["android", "phone"],
    requiredCapabilities: ["phoneMcp"],
  },
};

describe("bundled skill library", () => {
  it("selects a skill only when both its trigger and capability are present", () => {
    const rendered = instructionsFor("Open Uber on my Android", ["phoneMcp"], [phone]);
    expect(rendered).toContain("Use phone tools");
    expect(rendered).not.toContain('root="/skills/phone-harness"');
    expect(instructionsFor("Open Uber on my Android", ["phoneMcp"], [phone], { includeRoot: true }))
      .toContain('root="/skills/phone-harness"');
    expect(instructionsFor("Open Uber on my Android", [], [phone])).toBe("");
    expect(instructionsFor("Write a poem", ["phoneMcp"], [phone])).toBe("");
  });

  it("requires the manifest id to match its isolated folder", () => {
    expect(() => parseSkillManifest({
      ...phone.manifest,
      id: "other-skill",
    }, "/skills/phone-harness")).toThrow(/invalid id/);
  });

  it("loads a user skill without letting a broken sibling disable it", () => {
    const root = mkdtempSync(join(tmpdir(), "openmausbot-skills-"));
    const valid = join(root, "file-expense");
    mkdirSync(valid);
    writeFileSync(join(valid, "manifest.json"), JSON.stringify({
      id: "file-expense", name: "File expense", version: "1.0.0", description: "File expenses",
      defaultEnabled: true, triggerTerms: ["expense"], requiredCapabilities: [],
    }));
    writeFileSync(join(valid, "SKILL.md"), "---\nname: file-expense\ndescription: File expenses\n---\nDo it safely.\n");
    const broken = join(root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "manifest.json"), "not json");
    writeFileSync(join(broken, "SKILL.md"), "broken");

    expect(loadUserSkills(root).map((skill) => skill.manifest.id)).toEqual(["file-expense"]);
  });

  it("does not let a user skill shadow a bundled skill id", () => {
    expect(mergeSkills([phone], [{ ...phone, instructions: "user replacement" }])).toEqual([phone]);
  });

  it("treats a non-directory user skill root as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "openmausbot-skills-root-"));
    const file = join(root, "not-a-directory");
    writeFileSync(file, "nope");
    expect(loadUserSkills(file)).toEqual([]);
  });
});

describe("bundled verification skill", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));
  const instructions = skills.find((skill) => skill.manifest.id === "create-verification-skill")?.instructions ?? "";

  it("ships one reviewed authoring adapter", () => {
    const ids = skills.map((skill) => skill.manifest.id);
    expect(ids).toContain("create-verification-skill");
    expect(ids).not.toContain("maintain-verification-skill");
    expect(instructions).toContain("skill_manage");
    expect(instructions).not.toContain("~/.openmausbot");
    expect(instructions).not.toContain("propose_routine");
  });

  it("requires skill authoring and an explicit creation request", () => {
    for (const text of [
      "/create-verification-skill for my notes app",
      "can you make a verification skill so you can prove changes work",
    ]) {
      expect(selectBundledSkills(text, [], skills)).toEqual([]);
      expect(selectBundledSkills(text, ["skillAuthoring"], skills).map((skill) => skill.manifest.id))
        .toEqual(["create-verification-skill"]);
    }
  });

  it("does not mount for generic verification or maintenance phrasing", () => {
    for (const text of [
      "please verify the numbers in this invoice",
      "maintain the verification skill for atlas",
      "the verification skill is stale",
      "make a control cli",
      "create a feature map for my app",
    ]) {
      expect(selectBundledSkills(text, ["skillAuthoring"], skills)).toEqual([]);
    }
  });
});

describe("bundled reverse-engineering skill", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));
  const rea = skills.find((skill) => skill.manifest.id === "reverse-engineer-anything");

  it("ships with the manifest the loader can read", () => {
    expect(rea).toBeDefined();
    expect(rea!.manifest.defaultEnabled).toBe(true);
    expect(rea!.manifest.requiredCapabilities).toEqual(["customMcp"]);
  });

  it("mounts for a reverse-engineering request on a driver that can mount MCP servers", () => {
    for (const text of [
      "reverse engineer this app and tell me how the search works",
      "can you decompile the installer",
      "disassemble this binary for me",
    ]) {
      expect(selectBundledSkills(text, ["customMcp"], skills).map((skill) => skill.manifest.id))
        .toEqual(["reverse-engineer-anything"]);
    }
  });

  it("stays off a driver that can mount neither the MCP server nor a local shell", () => {
    // A cloud API driver has no local shell and cannot mount a user's MCP
    // servers; telling its bot to use REA would burn turns hunting for tools
    // that are not there.
    expect(selectBundledSkills("reverse engineer this app", [], skills)).toEqual([]);
  });

  it("stays off for requests that are not about reverse engineering", () => {
    for (const text of [
      "write a poem about the sea",
      "what is the weather like today",
      "add a button to the settings page",
    ]) {
      expect(selectBundledSkills(text, ["customMcp"], skills)).toEqual([]);
    }
  });

  it("tells the agent how to connect when the tools are not mounted", () => {
    // The skill alone cannot register the MCP server, so the instructions
    // have to carry the recipe or the agent dead-ends at "no such tool".
    expect(rea!.instructions).toContain("Plugins → MCP servers");
    expect(rea!.instructions).toContain("rea-agents");
    expect(rea!.instructions).toContain("binary_session");
  });
});
