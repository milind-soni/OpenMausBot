import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config.ts";

// config.ts resolves DATA_DIR at import time, so point this suite at a scratch dir before any module loads.
process.env.OMB_DATA_DIR = mkdtempSync(join(tmpdir(), "omb-skills-library-"));

const library = await import("./skill-library.ts");
const skills = await import("./skills.ts");
const config = await import("./config.ts");

const SKILL = (name: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: Reviews a PR the way this team reviews PRs.\n---\n\n# ${name}\n\n${body}\n`;
const TAGGED = (name: string, tags: string) =>
  `---\nname: ${name}\ndescription: Browsing tags on chip rows.\ntags: ${tags}\n---\n\n# ${name}\n\nDo the thing.\n`;
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
    expect(again.source).toBe("a");
    const clash = library.installLibrarySkill({ name: "deploy", instructions: SKILL("deploy", "Different body."), source: "c", root });
    expect(clash).toEqual({ error: 'a skill named "deploy" is already in the library — choose a different name' });
    expect(Object.keys(library.readSkillLibraryIndex(root))).toEqual(["deploy"]);
  });

  it("refuses to install over an unreadable or invalid index instead of resetting it", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-skills-library-"));
    writeFileSync(join(root, "index.json"), "{not json");
    const unreadable = library.installLibrarySkill({ name: "deploy", instructions: SKILL("deploy"), source: "a", root });
    expect(unreadable).toEqual({ error: "the skills library index could not be read" });
    expect(readFileSync(join(root, "index.json"), "utf8")).toBe("{not json");
    expect(existsSync(join(root, "skills", "deploy"))).toBe(false);

    writeFileSync(join(root, "index.json"), JSON.stringify({ deploy: { not: "an entry" } }));
    const invalid = library.installLibrarySkill({ name: "deploy", instructions: SKILL("deploy"), source: "a", root });
    expect(invalid).toEqual({ error: "the skills library index is invalid" });
    expect(JSON.parse(readFileSync(join(root, "index.json"), "utf8"))).toEqual({ deploy: { not: "an entry" } });
  });

  it("stores frontmatter tags when the caller passes none, and prefers explicit tags", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-skills-library-"));
    const parsed = library.installLibrarySkill({ name: "tag-me", instructions: TAGGED("tag-me", "deploy, ops"), source: "a", root });
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.tags).toEqual(["deploy", "ops"]);
    expect(library.readSkillLibraryIndex(root)["tag-me"]?.tags).toEqual(["deploy", "ops"]);

    const explicit = library.installLibrarySkill({ name: "tag-override", instructions: TAGGED("tag-override", "deploy"), source: "a", root, tags: ["custom"] });
    expect("error" in explicit).toBe(false);
    if ("error" in explicit) return;
    expect(explicit.tags).toEqual(["custom"]);
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

  it("makes a reviewed library skill available to every bot, including bots without an assignment", () => {
    const name = `universal-${Math.random().toString(36).slice(2, 10)}`;
    const universal = library.installLibrarySkill({ name, instructions: SKILL(name), source: "lib", reviewState: "approved" });
    expect("error" in universal).toBe(false);
    expect(library.setLibrarySkillEveryBot(name, true)).toMatchObject({ everyBot: true });
    try {
      expect(skills.resolveBotSkills(`universal-${Math.random()}`, [])).toEqual(expect.arrayContaining([
        expect.objectContaining({ name, enabled: true }),
      ]));
      // No assignment list means the library is off: an every-bot skill stays out too.
      expect(skills.resolveBotSkills(`universal-${Math.random()}`, undefined).map((skill) => skill.name)).not.toContain(name);
      // The bot's Skills page lists it as the bot's own library skill, not as one still to assign.
      const page = skills.listBotSkillsWithOrigin(`universal-${Math.random()}`, undefined);
      expect(page.skills.map((skill) => skill.name)).toContain(name);
      expect(page.library.map((skill) => skill.name)).not.toContain(name);
    } finally {
      expect(library.setLibrarySkillEveryBot(name, false)).toMatchObject({ everyBot: false });
    }
  });

  it("lists an every-bot skill in the turn index of a bot with no assignments, only while the library is on", async () => {
    const { createSkillsLibraryHost } = await import("./host/skills-library.ts");
    const name = `everyone-${Math.random().toString(36).slice(2, 10)}`;
    library.installLibrarySkill({ name, instructions: SKILL(name), source: "lib", reviewState: "approved" });
    library.setLibrarySkillEveryBot(name, true);
    try {
      const record = { id: bot, threadId: "main" } as import("./store.ts").BotRecord;
      const hostWith = (cfg: AppConfig) => createSkillsLibraryHost({
        store: { bot: () => record, messagesFor: () => [], taskByThread: () => undefined } as unknown as import("./store.ts").Store,
        cfg,
        appendSkillRequestCard: () => ({ requestId: "", summary: "" }),
      });
      const on = hostWith({ features: { skillsLibrary: true } } as AppConfig);
      expect(on.skillsIndex(record, "main")).toContain(name);
      expect(on.skillsIndex(record, undefined)).toContain(name);
      expect(on.expandSkillCommand(record, "main", `/${name}`)).toContain(`ran your ${name} skill`);
      const off = hostWith({} as AppConfig);
      expect(off.skillsIndex(record, "main")).not.toContain(name);
      expect(off.expandSkillCommand(record, "main", `/${name}`)).toBe(`/${name}`);
    } finally {
      library.setLibrarySkillEveryBot(name, false);
    }
  });

  it("defaults the feature flag off and switches on only via features.skillsLibrary", () => {
    expect(library.skillsLibraryEnabled({} as AppConfig)).toBe(false);
    expect(library.skillsLibraryEnabled({ features: {} } as AppConfig)).toBe(false);
    expect(library.skillsLibraryEnabled({ features: { skillsLibrary: true } } as AppConfig)).toBe(true);
  });

  it("parseStoredConfig keeps features.skillsLibrary while stripping genuinely unknown keys", () => {
    const stored = config.parseStoredConfig({ features: { skillsLibrary: true, browser: true } });
    expect(stored).toEqual({ features: { skillsLibrary: true, browser: true } });
    expect(library.skillsLibraryEnabled(stored)).toBe(true);
    expect(library.skillsLibraryEnabled(config.parseStoredConfig({ features: { browser: true } }))).toBe(false);
    expect(config.parseStoredConfig({ features: { skillsLibrary: true, teleport: true } })).toEqual({
      features: { skillsLibrary: true },
    });
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
    expect(shared.source).toBe("private:test");
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
    expect(withLibrary).toContain("own-skill");
  });
});
