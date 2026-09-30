import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config.ts";

// config.ts resolves DATA_DIR at import time, so point this suite at a
// scratch dir before any module under test loads.
process.env.OMB_DATA_DIR = mkdtempSync(join(tmpdir(), "omb-skills-library-"));

const library = await import("./skill-library.ts");
const skills = await import("./skills.ts");
const config = await import("./config.ts");

const SKILL = (name: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: Reviews a PR the way this team reviews PRs.\n---\n\n# ${name}\n\n${body}\n`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

let bot: string;
beforeEach(() => {
  bot = `lib-bot-${Math.random().toString(36).slice(2, 10)}`;
});

describe("skills library store", () => {
  it("installs a skill: bytes on disk, entry in the index, listing, invalidation event", () => {
    const events: Array<{ kind: string; name: string }> = [];
    library.skillLibraryEvents.on("invalidate", (event) => events.push(event));
    const listing = library.installLibrarySkill({
      name: "code-review",
      instructions: SKILL("code-review"),
      source: "https://example.com/skills",
      reviewState: "approved",
    });
    expect("error" in listing).toBe(false);
    if ("error" in listing) return;
    expect(listing).toMatchObject({ name: "code-review", enabled: true, editable: false, source: "https://example.com/skills" });
    expect(existsSync(join(library.skillsLibraryRoot(), "skills", "code-review", "SKILL.md"))).toBe(true);
    const index = library.readSkillLibraryIndex();
    expect(index["code-review"]).toMatchObject({ sha256: sha256(SKILL("code-review")), reviewState: "approved" });
    expect(events).toContainEqual({ kind: "install", name: "code-review" });
    expect(library.readLibrarySkillFile("code-review")).toBe(SKILL("code-review"));
  });

  it("is idempotent for identical bytes and refuses a different skill under the same name", () => {
    // Fresh root: this suite shares one scratch DATA_DIR, and this test asserts the exact index contents.
    const root = mkdtempSync(join(tmpdir(), "omb-skills-library-"));
    const first = library.installLibrarySkill({ name: "deploy", instructions: SKILL("deploy"), source: "a", root });
    expect("error" in first).toBe(false);
    const again = library.installLibrarySkill({ name: "deploy", instructions: SKILL("deploy"), source: "b", root });
    expect("error" in again).toBe(false);
    if ("error" in again) return;
    expect(again.source).toBe("a"); // the existing entry wins
    const clash = library.installLibrarySkill({ name: "deploy", instructions: SKILL("deploy", "Different body."), source: "c", root });
    expect(clash).toEqual({ error: 'a skill named "deploy" is already in the library — choose a different name' });
    expect(Object.keys(library.readSkillLibraryIndex(root))).toEqual(["deploy"]);
  });

  it("fails closed on tampered bytes: listing disabled with a warning, reads return null", () => {
    library.installLibrarySkill({ name: "audit", instructions: SKILL("audit"), source: "a", reviewState: "approved" });
    writeFileSync(join(library.skillsLibraryRoot(), "skills", "audit", "SKILL.md"), SKILL("audit", "Tampered."), { mode: 0o600 });
    const [listing] = library.listLibrarySkills().filter((skill) => skill.name === "audit");
    expect(listing.enabled).toBe(false);
    expect(listing.warnings).toContain("stored SKILL.md changed after review — enablement is blocked");
    expect(library.readLibrarySkillFile("audit")).toBeNull();
    const approve = library.setLibrarySkillReviewState("audit", "approved");
    expect(approve).toEqual({ error: "stored SKILL.md changed after review — the library entry cannot be approved" });
  });

  it("toggles review state at library scope and emits an invalidation event", () => {
    library.installLibrarySkill({ name: "triage", instructions: SKILL("triage"), source: "a", reviewState: "approved" });
    const events: Array<{ kind: string; name: string }> = [];
    library.skillLibraryEvents.on("invalidate", (event) => events.push(event));
    const disabled = library.setLibrarySkillReviewState("triage", "disabled");
    expect("error" in disabled).toBe(false);
    if (!("error" in disabled)) expect(disabled.enabled).toBe(false);
    expect(library.readSkillLibraryIndex()["triage"]?.reviewState).toBe("disabled");
    expect(events).toContainEqual({ kind: "review-state", name: "triage" });
  });

  it("resolves a skill name bot-private first, then library, then bundled", () => {
    expect(library.resolveSkillSourceOrder("x", { private: 1, library: 2, bundled: 3 })).toMatchObject({ source: "private", value: 1 });
    expect(library.resolveSkillSourceOrder("x", { library: 2, bundled: 3 })).toMatchObject({ source: "library", value: 2 });
    expect(library.resolveSkillSourceOrder("x", { bundled: 3 })).toMatchObject({ source: "bundled", value: 3 });
    expect(library.resolveSkillSourceOrder("x", {})).toBeNull();
  });

  it("defaults the feature flag off and switches on only via features.skillsLibrary", () => {
    expect(config.skillsLibraryEnabled({} as AppConfig)).toBe(false);
    expect(config.skillsLibraryEnabled({ features: {} } as AppConfig)).toBe(false);
    expect(config.skillsLibraryEnabled({ features: { skillsLibrary: true } } as AppConfig)).toBe(true);
  });
});

describe("assignment resolution", () => {
  it("adds assigned library skills beside private ones, private winning name collisions", () => {
    skills.installSkill(bot, "private:test", [{ path: "SKILL.md", content: SKILL("shared-name", "Private copy.") }]);
    skills.setSkillEnabled(bot, "shared-name", true);
    library.installLibrarySkill({ name: "shared-name", instructions: SKILL("shared-name", "Library copy."), source: "lib", reviewState: "approved" });
    library.installLibrarySkill({ name: "library-only", instructions: SKILL("library-only"), source: "lib", reviewState: "approved" });

    const resolved = skills.resolveBotSkills(bot, ["shared-name", "library-only"]);
    expect(resolved.map((skill) => skill.name).sort()).toEqual(["library-only", "shared-name"]);
    const shared = resolved.find((skill) => skill.name === "shared-name")!;
    expect(shared.source).toBe("private:test"); // bot-private beats the library
    const only = resolved.find((skill) => skill.name === "library-only")!;
    expect(only.source).toBe("lib");
    expect(only.editable).toBe(false);
  });

  it("without assignments, resolution is exactly listSkills (the flag-off contract)", () => {
    skills.installSkill(bot, "private:test", [{ path: "SKILL.md", content: SKILL("solo") }]);
    library.installLibrarySkill({ name: "library-only", instructions: SKILL("library-only"), source: "lib", reviewState: "approved" });
    expect(skills.resolveBotSkills(bot, undefined)).toEqual(skills.listSkills(bot));
    expect(skills.resolveBotSkills(bot, [])).toEqual(skills.listSkills(bot));
  });

  it("renders assigned library skills into the prompt index with the library path", () => {
    skills.installSkill(bot, "private:test", [{ path: "SKILL.md", content: SKILL("own-skill") }]);
    skills.setSkillEnabled(bot, "own-skill", true);
    library.installLibrarySkill({ name: "library-skill", instructions: SKILL("library-skill"), source: "lib", reviewState: "approved" });

    const without = skills.skillsSystemPrompt(bot);
    expect(without).not.toContain("library-skill");
    const withLibrary = skills.skillsSystemPrompt(bot, ["library-skill"]);
    expect(withLibrary).toContain("library-skill");
    expect(withLibrary).toContain(JSON.stringify(join(library.skillsLibraryRoot(), "skills", "library-skill", "SKILL.md")));
    // the private line keeps its workspace path
    expect(withLibrary).toContain("own-skill");
  });
});
