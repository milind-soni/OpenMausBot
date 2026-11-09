import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(listing.warnings).toContain("stored skill files changed after review — enablement is blocked");
    expect(library.readLibrarySkillFile("audit")).toBeNull();
    const approve = library.setLibrarySkillReviewState("audit", "approved");
    expect(approve).toEqual({ error: "stored skill files changed after review — the library entry cannot be approved" });
  });

  it("stores a whole skill folder, records its GitHub origin and blocks it once a file beside SKILL.md changes", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-skills-library-"));
    const github = { owner: "x", repo: "y", ref: "HEAD", commit: "b".repeat(40), path: "skills/folder-skill" };
    mkdirSync(join(root, "skills", "folder-skill"), { recursive: true });
    writeFileSync(join(root, "skills", "folder-skill", "left-by-a-crash.md"), "unreferenced");
    const listing = library.installLibrarySkill({
      name: "folder-skill",
      instructions: SKILL("folder-skill"),
      source: "github.com/x/y/skills/folder-skill",
      reviewState: "approved",
      files: [
        { path: "references/guide.md", content: "# Guide\n" },
        { path: "scripts/run.sh", content: "#!/bin/sh\necho run\n", executable: true },
      ],
      skippedFiles: ["video.mp4"],
      github,
      root,
    });
    expect(listing).toMatchObject({ name: "folder-skill", enabled: true, skippedFiles: ["video.mp4"], github, warnings: [] });
    const folder = join(root, "skills", "folder-skill");
    expect(readFileSync(join(folder, "references", "guide.md"), "utf8")).toBe("# Guide\n");
    expect(existsSync(join(folder, "left-by-a-crash.md"))).toBe(false);
    expect(library.readSkillLibraryIndex(root)["folder-skill"]).toMatchObject({ filesSha256: expect.stringMatching(/^[a-f0-9]{64}$/), github });

    writeFileSync(join(folder, "scripts", "run.sh"), "#!/bin/sh\necho changed\n");
    const [changed] = library.listLibrarySkills(root);
    expect(changed).toMatchObject({ enabled: false, warnings: ["stored skill files changed after review — enablement is blocked"] });
    expect(library.installLibrarySkill({ name: "escapes", instructions: SKILL("escapes"), source: "a", files: [{ path: "../x.md", content: "x" }], root }))
      .toEqual({ error: expect.stringContaining("outside the skill folder") });
    expect(existsSync(join(root, "skills", "x.md"))).toBe(false);
    expect(library.readSkillLibraryIndex(root)["escapes"]).toBeUndefined();
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
      expect(on.expandSkillCommand(record, "main", `/${name}`, undefined, [], true)).toContain(`ran your ${name} skill`);
      const off = hostWith({} as AppConfig);
      expect(off.skillsIndex(record, "main")).not.toContain(name);
      expect(off.expandSkillCommand(record, "main", `/${name}`, undefined, [], true)).toBe(`/${name}`);
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


describe("shared skill maintainer", () => {
  it("preserves the package and assignment state and rejects stale, tampered and invalid transfers", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-maintainer-"));
    const name = "maintainer-fixture";
    const installed = library.installLibrarySkill({ name, instructions: SKILL(name), source: "fixture", reviewState: "approved", root,
      files: [{ path: "references/details.md", content: "important details" }] });
    expect(installed).not.toHaveProperty("error");
    const original = library.readSkillLibraryIndex(root)[name]!;
    const originalFile = readFileSync(join(root, "skills", name, "references", "details.md"), "utf8");
    const assignedBotIds = ["author", "target"];
    const baseRevision = library.libraryManagementRevision(original, assignedBotIds);
    const transfer = library.transferLibraryMaintainer({ name, maintainerBotId: "target", baseRevision, assignedBotIds, root });
    expect(transfer).toHaveProperty("entry.maintainerBotId", "target");
    if ("error" in transfer) throw new Error(transfer.error);
    const { maintainerBotId, maintainerVersion, ...after } = library.readSkillLibraryIndex(root)[name]!;
    expect({ maintainerBotId, maintainerVersion }).toMatchObject({ maintainerBotId: "target" });
    expect(after).toEqual(original);
    expect(readFileSync(join(root, "skills", name, "references", "details.md"), "utf8")).toBe(originalFile);
    expect(library.transferLibraryMaintainer({ name, maintainerBotId: "author", baseRevision, assignedBotIds, root })).toHaveProperty("error");
    expect(library.transferLibraryMaintainer({ name, maintainerBotId: "author", baseRevision: transfer.revision, assignedBotIds: ["author"], root })).toHaveProperty("error");
    writeFileSync(join(root, "skills", name, "references", "details.md"), "tampered");
    expect(library.transferLibraryMaintainer({ name, maintainerBotId: "author", baseRevision: transfer.revision, assignedBotIds, root })).toHaveProperty("error");
    expect(library.readSkillLibraryIndex(root)[name]?.maintainerBotId).toBe("target");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("leaves the old maintainer and package intact if the index cannot be written", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-maintainer-write-"));
    const name = "write-failure";
    library.installLibrarySkill({ name, instructions: SKILL(name), source: "fixture", reviewState: "approved", root });
    const before = readFileSync(join(root, "index.json"), "utf8");
    const revision = library.libraryManagementRevision(library.readSkillLibraryIndex(root)[name]!, ["target"]);
    chmodSync(root, 0o500);
    try {
      expect(library.transferLibraryMaintainer({ name, maintainerBotId: "target", baseRevision: revision, assignedBotIds: ["target"], root })).toHaveProperty("error");
      expect(readFileSync(join(root, "index.json"), "utf8")).toBe(before);
      expect(library.readLibrarySkillFile(name, root)).toBe(SKILL(name));
    } finally { chmodSync(root, 0o700); }
  });

  it("validates visibility, existing access, revisions and readback without changing bot permissions", async () => {
    const { createSkillsLibraryHost } = await import("./host/skills-library.ts");
    const name = `transfer-${Math.random().toString(36).slice(2, 10)}`;
    const bots = [
      { id: `author-${name}`, name: "Author", section: "team", assignedSkills: [name] },
      { id: `target-${name}`, name: "Target", section: "team", assignedSkills: [name] },
      { id: `other-${name}`, name: "Other", section: "team", assignedSkills: [] as string[] },
      { id: `private-${name}`, name: "Private", section: "team", visibility: "admins", assignedSkills: [name] },
    ] as import("./store.ts").BotRecord[];
    const store = { bots, bot: (id: string) => bots.find((item) => item.id === id), groupByThread: () => undefined } as unknown as import("./store.ts").Store;
    const host = createSkillsLibraryHost({ store, cfg: { features: { skillsLibrary: true } } as AppConfig,
      appendSkillRequestCard: () => ({ requestId: "unused", summary: "" }) });
    library.installLibrarySkill({ name, instructions: SKILL(name), source: "fixture", reviewState: "approved" });
    const author = bots[0]!; const target = bots[1]!;
    const listing = () => host.harnessListing(author.id, host.listBotSkills(author)).find((item) => item.name === name)!;
    const before = listing().shared!;
    expect(before).toMatchObject({ scope: "selected_bots", assigned: true, enabled: true, maintainer_status: "unassigned" });
    const assignmentSnapshot = JSON.stringify(bots.map((item) => item.assignedSkills));
    expect(host.transferMaintainer(author, "fixture", name, target.id, before.management_revision, null)[0]).toBe(403);
    const direct = "full-access" as import("./direct-apply.ts").DirectApply;
    expect(host.transferMaintainer(author, "fixture", name, bots[2]!.id, before.management_revision, direct)[0]).toBe(422);
    expect(host.transferMaintainer(author, "fixture", name, bots[3]!.id, before.management_revision, direct)[0]).toBe(422);
    const [status, receipt] = host.transferMaintainer(author, "fixture", name, target.id, before.management_revision, direct);
    expect(status).toBe(200);
    expect(receipt).toMatchObject({ state: "applied", result: { maintainer_bot_id: target.id, maintainer_status: "assigned", scope: "selected_bots", enabled: true } });
    expect(listing().shared).toEqual(receipt.result);
    expect(JSON.stringify(bots.map((item) => item.assignedSkills))).toBe(assignmentSnapshot);
    expect(host.transferMaintainer(author, "fixture", name, author.id, before.management_revision, direct)[0]).toBe(409);
    target.assignedSkills = [];
    expect(listing().shared?.maintainer_status).toBe("no_access");
  });
});
