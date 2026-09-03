import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decideBundledSkills,
  enabledProviderCapabilityIds,
  effectiveSkillIds,
  effectiveSkillToolIds,
  filterSkillGrantState,
  parseSkillManifest,
  removeGlobalImportedSkill,
  selectExactSkill,
  selectExactSkills,
  skillCatalog,
  skillInstructionsFor,
  validateSkillGrantPatch,
  type BundledSkill,
} from "./skill-library.ts";
import { loadBundledSkills, loadUserSkills, mergeSkills, selectBundledSkills } from "./skill-library.ts";

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
    tools: ["phone"],
  },
};

describe("bundled skill library", () => {
  it("derives every true provider capability deterministically and ignores metadata", () => {
    expect(enabledProviderCapabilityIds({
      phoneMcp: true,
      agentsMcp: true,
      computerMcp: false,
      futureBooleanFlag: true,
      images: undefined,
      sessionModelSwitch: "in-session",
      effortLevels: ["high"],
      truthyMetadata: "true",
    })).toEqual(["agentsMcp", "futureBooleanFlag", "phoneMcp"]);
  });

  it("selects a skill only when both its trigger and capability are present", () => {
    const rendered = skillInstructionsFor("Open Uber on my Android", ["phoneMcp"], [phone]);
    expect(rendered).toContain("Use phone tools");
    expect(rendered).not.toContain('root="/skills/phone-harness"');
    expect(skillInstructionsFor("Open Uber on my Android", ["phoneMcp"], [phone], { includeRoot: true }))
      .toContain('root="/skills/phone-harness"');
    expect(skillInstructionsFor("Open Uber on my Android", [], [phone])).toBe("");
    expect(skillInstructionsFor("Write a poem", ["phoneMcp"], [phone])).toBe("");
  });

  it("keeps defaults, explicit skill deny, explicit tool deny, and stale ids deterministic", () => {
    expect(effectiveSkillIds([phone])).toEqual(["phone-harness"]);
    expect(effectiveSkillToolIds([phone])).toEqual(["phone"]);
    expect(effectiveSkillIds([phone], { skillGrants: [] })).toEqual([]);
    expect(effectiveSkillToolIds([phone], { skillGrants: [], skillToolGrants: undefined })).toEqual([]);
    expect(filterSkillGrantState({ skillGrants: ["stale", "phone-harness"], skillToolGrants: ["stale", "phone"] }, [phone])).toEqual({
      skillGrants: ["phone-harness"],
      skillToolGrants: ["phone"],
    });
  });

  it("reports each gate and never mounts a declared tool without its grant", () => {
    expect(decideBundledSkills("Open my Android", ["phoneMcp"], [phone]).mountedSkillToolIds).toEqual(["phone"]);
    expect(decideBundledSkills("Open my Android", ["phoneMcp"], [phone], { skillGrants: [] }).decisions[0]).toMatchObject({
      reason: "skill-denied",
    });
    expect(decideBundledSkills("Open my Android", ["phoneMcp"], [phone], {
      skillGrants: ["phone-harness"],
      skillToolGrants: [],
    })).toMatchObject({ mountedSkillToolIds: [], decisions: [{ reason: "tool-denied" }] });
    expect(decideBundledSkills("Open my Android", [], [phone]).decisions[0]).toMatchObject({
      reason: "capability-missing",
    });
    expect(decideBundledSkills("Write a poem", ["phoneMcp"], [phone]).decisions[0]).toMatchObject({
      reason: "trigger-mismatch",
    });
  });

  it("validates and sorts new grant ids while rejecting unknown ids", () => {
    expect(validateSkillGrantPatch({ skillGrants: ["phone-harness", "phone-harness"], skillToolGrants: ["phone"] }, [phone])).toEqual({
      skillGrants: ["phone-harness"],
      skillToolGrants: ["phone"],
    });
    expect(validateSkillGrantPatch({ skillGrants: [] }, [phone])).toEqual({ skillGrants: [] });
    expect(() => validateSkillGrantPatch({ skillGrants: ["unknown"] }, [phone])).toThrow(/unknown id/);
    expect(() => validateSkillGrantPatch({ skillToolGrants: ["unknown"] }, [phone])).toThrow(/unknown id/);
  });

  it("requires the manifest id to match its isolated folder", () => {
    expect(() => parseSkillManifest({
      ...phone.manifest,
      id: "other-skill",
    }, "/skills/phone-harness")).toThrow(/invalid id/);
  });

  it("requires a validated tool declaration", () => {
    expect(() => parseSkillManifest({ ...phone.manifest, tools: ["bad tool"] }, "/skills/phone-harness")).toThrow(/invalid tools/);
    expect(() => parseSkillManifest({ ...phone.manifest, tools: undefined }, "/skills/phone-harness")).toThrow(/invalid tools/);
  });

  it("keeps ordinary text manual-only and exact-selects at most one skill", () => {
    expect(selectExactSkill(undefined, ["phoneMcp"], [phone])).toEqual({
      selectedSkills: [],
      mountedSkillToolIds: [],
      decisions: [],
    });
    expect(selectExactSkill("phone-harness", ["phoneMcp"], [phone])).toMatchObject({
      selectedSkills: [phone],
      mountedSkillToolIds: ["phone"],
      decisions: [{ skillId: "phone-harness", reason: "selected" }],
    });
    expect(selectExactSkill("missing", ["phoneMcp"], [phone])).toMatchObject({
      selectedSkills: [],
      decisions: [{ skillId: "missing", reason: "unknown" }],
    });
    expect(parseSkillManifest(phone.manifest, "/skills/phone-harness")).not.toHaveProperty("dependencies");
  });

  it("returns exact hidden-grant, capability, and tool refusal reasons", () => {
    expect(selectExactSkill("phone-harness", ["phoneMcp"], [phone], { skillGrants: [] }).decisions[0]?.reason)
      .toBe("skill-denied");
    expect(selectExactSkill("phone-harness", [], [phone]).decisions[0]?.reason).toBe("capability-missing");
    expect(selectExactSkill("phone-harness", ["phoneMcp"], [phone], {
      skillGrants: ["phone-harness"],
      skillToolGrants: [],
    }).decisions[0]?.reason).toBe("tool-denied");
    const generic = { ...phone, manifest: { ...phone.manifest, id: "generic", requiredCapabilities: [], tools: [] } };
    expect(selectExactSkill("generic", [], [generic]).decisions[0]?.reason).toBe("selected");
  });

  it("refuses a partial batch and keeps requested order with a deduped tool union", () => {
    const second = { ...phone, manifest: { ...phone.manifest, id: "generic", name: "Generic", requiredCapabilities: [], tools: ["phone"] } };
    expect(selectExactSkills(["phone-harness", "missing"], ["phoneMcp"], [phone, second]).decisions.map((item) => item.skillId)).toEqual([
      "phone-harness", "missing",
    ]);
    expect(selectExactSkills(["generic", "phone-harness"], ["phoneMcp"], [phone, second])).toMatchObject({
      selectedSkills: [second, phone],
      mountedSkillToolIds: ["phone"],
    });
  });

  it("expands one-level and transitive dependencies in deterministic post-order", () => {
    const leaf = { ...phone, manifest: { ...phone.manifest, id: "leaf", name: "Leaf", requiredCapabilities: [], tools: [] } };
    const middle = { ...phone, manifest: { ...phone.manifest, id: "middle", name: "Middle", dependencies: ["leaf"], requiredCapabilities: [], tools: [] } };
    const root = { ...phone, manifest: { ...phone.manifest, id: "root", name: "Root", dependencies: ["middle"], requiredCapabilities: [], tools: [] } };
    expect(selectExactSkills(["root"], [], [root, middle, leaf])).toMatchObject({
      selectedSkills: [leaf, middle, root],
      decisions: [
        { skillId: "leaf", reason: "dependency" },
        { skillId: "middle", reason: "dependency" },
        { skillId: "root", reason: "selected" },
      ],
    });

    const zed = { ...leaf, manifest: { ...leaf.manifest, id: "zed", name: "Zed" } };
    const branch = { ...leaf, manifest: { ...leaf.manifest, id: "branch", name: "Branch", dependencies: ["zed"] } };
    const deterministicRoot = { ...leaf, manifest: { ...leaf.manifest, id: "deterministic-root", name: "Root", dependencies: ["zed", "branch"] } };
    expect(selectExactSkills(["deterministic-root"], [], [deterministicRoot, zed, branch, leaf]).selectedSkills.map(({ manifest }) => manifest.id))
      .toEqual(["zed", "branch", "deterministic-root"]);
  });

  it("atomically refuses missing, cyclic, and over-limit dependency graphs", () => {
    const missing = { ...phone, manifest: { ...phone.manifest, id: "needs-missing", name: "Needs missing", dependencies: ["missing"] } };
    expect(selectExactSkills(["needs-missing"], ["phoneMcp"], [missing])).toMatchObject({
      selectedSkills: [],
      mountedSkillToolIds: [],
      decisions: expect.arrayContaining([expect.objectContaining({ skillId: "missing", reason: "dependency-missing" })]),
    });

    const cycleA = { ...phone, manifest: { ...phone.manifest, id: "cycle-a", name: "Cycle A", dependencies: ["cycle-b"], requiredCapabilities: [], tools: [] } };
    const cycleB = { ...phone, manifest: { ...phone.manifest, id: "cycle-b", name: "Cycle B", dependencies: ["cycle-a"], requiredCapabilities: [], tools: [] } };
    const cycle = selectExactSkills(["cycle-a"], [], [cycleA, cycleB]);
    expect(cycle.selectedSkills).toEqual([]);
    expect(cycle.mountedSkillToolIds).toEqual([]);
    expect(cycle.decisions.filter(({ reason }) => reason === "dependency-cycle").map(({ skillId }) => skillId)).toEqual(["cycle-a", "cycle-b"]);

    const chain: BundledSkill[] = [];
    for (let index = 0; index < 9; index++) {
      chain.push({
        ...phone,
        manifest: {
          ...phone.manifest,
          id: `chain-${index}`,
          name: `Chain ${index}`,
          requiredCapabilities: [],
          tools: [],
          ...(index === 0 ? {} : { dependencies: [`chain-${index - 1}`] }),
        },
      });
    }
    const overflow = selectExactSkills(["chain-8"], [], chain);
    expect(overflow.selectedSkills).toEqual([]);
    expect(overflow.mountedSkillToolIds).toEqual([]);
    expect(overflow.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ skillId: "chain-8", reason: "selection-overflow" })]));
  });

  it("keeps grants, capabilities, and tools authoritative for dependencies", () => {
    const dependency = { ...phone, manifest: { ...phone.manifest, id: "dependency", name: "Dependency", requiredCapabilities: ["research"], tools: ["dependency-tool"] } };
    const root = { ...phone, manifest: { ...phone.manifest, id: "root-with-dependency", name: "Root", dependencies: ["dependency"], requiredCapabilities: [], tools: [] } };
    for (const [grants, expectedReason] of [
      [{ skillGrants: ["root-with-dependency"] }, "skill-denied"],
      [{ skillGrants: ["root-with-dependency", "dependency"], skillToolGrants: ["phone"] }, "capability-missing"],
    ] as const) {
      const selection = selectExactSkills(["root-with-dependency"], [], [root, dependency], grants);
      expect(selection.selectedSkills).toEqual([]);
      expect(selection.mountedSkillToolIds).toEqual([]);
      expect(selection.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ skillId: "dependency", reason: expectedReason })]));
    }
    expect(selectExactSkills(["root-with-dependency"], ["research"], [root, dependency], {
      skillGrants: ["root-with-dependency", "dependency"],
      skillToolGrants: ["phone"],
    }).decisions).toEqual(expect.arrayContaining([expect.objectContaining({ skillId: "dependency", reason: "tool-denied" }), expect.objectContaining({ skillId: "root-with-dependency", reason: "selected" })]));
  });

  it("rejects invalid dependency declarations and exposes catalog dependencies", () => {
    expect(() => parseSkillManifest({ ...phone.manifest, dependencies: ["phone-harness", "phone-harness"] }, "/skills/phone-harness"))
      .toThrow(/duplicate/);
    expect(() => parseSkillManifest({ ...phone.manifest, dependencies: ["phone-harness"] }, "/skills/phone-harness"))
      .toThrow(/self dependency/);
    expect(() => parseSkillManifest({ ...phone.manifest, dependencies: ["bad id"] }, "/skills/phone-harness"))
      .toThrow(/invalid dependencies/);
    const withDependency = { ...phone, manifest: { ...phone.manifest, dependencies: ["base-skill"] } };
    expect(skillCatalog([withDependency])[0]).toMatchObject({ id: "phone-harness", dependencies: ["base-skill"] });
  });

  it("deletes only an imported app-wide directory and rejects recorded or unsafe ids", () => {
    const root = mkdtempSync(join(tmpdir(), "openmausbot-global-skill-remove-"));
    const imported = join(root, "imported-skill");
    mkdirSync(imported);
    writeFileSync(join(imported, "manifest.json"), JSON.stringify({
      id: "imported-skill", name: "Imported", version: "1.0.0", description: "Imported",
      defaultEnabled: true, triggerTerms: ["imported"], requiredCapabilities: [], tools: [], origin: "imported",
    }));
    writeFileSync(join(imported, "SKILL.md"), "---\nname: imported-skill\ndescription: Imported\n---\nUse it.\n");
    expect(removeGlobalImportedSkill(root, "imported-skill")).toEqual({ removed: true });
    expect(existsSync(imported)).toBe(false);
    expect(removeGlobalImportedSkill(root, "../outside")).toMatchObject({ error: expect.any(String) });
    const recorded = join(root, "recorded-skill");
    mkdirSync(recorded);
    writeFileSync(join(recorded, "manifest.json"), JSON.stringify({
      id: "recorded-skill", name: "Recorded", version: "1.0.0", description: "Recorded",
      defaultEnabled: true, triggerTerms: ["recorded"], requiredCapabilities: [], tools: [], origin: "recorded",
    }));
    writeFileSync(join(recorded, "SKILL.md"), "---\nname: recorded-skill\ndescription: Recorded\n---\nUse it.\n");
    expect(removeGlobalImportedSkill(root, "recorded-skill")).toMatchObject({ error: expect.stringMatching(/imported/) });
    expect(existsSync(recorded)).toBe(true);
  });

  it("loads a recorded skill without letting a broken sibling disable it", () => {
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

    const loaded = loadUserSkills(root);
    expect(loaded.map((skill) => skill.manifest.id)).toEqual(["file-expense"]);
    expect(skillCatalog(loaded)).toEqual([
      expect.objectContaining({ id: "file-expense", origin: "recorded", status: "available" }),
    ]);
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
