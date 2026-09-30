import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts resolves DATA_DIR at import time; isolate before importing.
process.env.OMB_DATA_DIR = mkdtempSync(join(tmpdir(), "omb-skills-migration-"));

const library = await import("./skill-library.ts");
const skills = await import("./skills.ts");
const migration = await import("./skills-library-migration.ts");
const { workspaceDir } = await import("./workspace.ts");

const SKILL = (name: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: Reviews a PR the way this team reviews PRs.\n---\n\n# ${name}\n\n${body}\n`;

let botA: string;
let botB: string;
beforeEach(() => {
  botA = `mig-a-${Math.random().toString(36).slice(2, 10)}`;
  botB = `mig-b-${Math.random().toString(36).slice(2, 10)}`;
});

describe("skills library migration", () => {
  it("deduplicates identical per-bot copies by sha256 and assigns both bots", () => {
    const content = SKILL("shared-review", "Identical bytes.");
    for (const bot of [botA, botB]) {
      skills.installSkill(bot, "private:test", [{ path: "SKILL.md", content }]);
      skills.setSkillEnabled(bot, "shared-review", true);
    }
    const reportA = migration.migrateBotSkillsToLibrary(botA);
    const reportB = migration.migrateBotSkillsToLibrary(botB);
    expect(reportA.outcomes).toEqual([expect.objectContaining({ botId: botA, name: "shared-review", outcome: "migrated" })]);
    expect(reportB.outcomes).toEqual([expect.objectContaining({ botId: botB, name: "shared-review", outcome: "deduplicated" })]);

    const index = library.readSkillLibraryIndex();
    expect(Object.keys(index)).toEqual(["shared-review"]);
    expect(reportA.assignments[botA]).toEqual(["shared-review"]);
    expect(reportB.assignments[botB]).toEqual(["shared-review"]);
    // both bots resolve the one library entry through their assignment
    expect(skills.resolveBotSkills(botA, reportA.assignments[botA]).map((skill) => skill.sha256)).toEqual([index["shared-review"]!.sha256]);
    expect(skills.resolveBotSkills(botB, reportB.assignments[botB]).map((skill) => skill.sha256)).toEqual([index["shared-review"]!.sha256]);
  });

  it("archives originals instead of deleting them and clears the per-bot manifest", () => {
    const content = SKILL("archive-me", "Precious bytes.");
    skills.installSkill(botA, "private:test", [{ path: "SKILL.md", content }]);
    skills.setSkillEnabled(botA, "archive-me", true);
    migration.migrateBotSkillsToLibrary(botA);

    const archive = join(library.skillsLibraryRoot(), "archive", botA, "archive-me", "SKILL.md");
    expect(existsSync(archive)).toBe(true);
    expect(readFileSync(archive, "utf8")).toBe(content);
    expect(existsSync(join(workspaceDir(botA), "skills", "archive-me"))).toBe(false);
    expect(skills.listSkills(botA)).toEqual([]);
  });

  it("keeps a conflicting per-bot copy in place when the library name is taken", () => {
    skills.installSkill(botA, "private:test", [{ path: "SKILL.md", content: SKILL("conflict", "First copy.") }]);
    skills.installSkill(botB, "private:test", [{ path: "SKILL.md", content: SKILL("conflict", "Second, different copy.") }]);
    migration.migrateBotSkillsToLibrary(botA);
    const reportB = migration.migrateBotSkillsToLibrary(botB);

    expect(reportB.outcomes).toEqual([expect.objectContaining({ botId: botB, outcome: "skipped" })]);
    expect(existsSync(join(workspaceDir(botB), "skills", "conflict", "SKILL.md"))).toBe(true);
    expect(skills.listSkills(botB).map((skill) => skill.name)).toEqual(["conflict"]);
    expect(reportB.assignments[botB]).toBeUndefined();
  });

  it("maps organization stamps onto library entries so org installs become a source", () => {
    const content = SKILL("org-playbook");
    const stamp = { installId: "a".repeat(32), key: "org-playbook", release: "2.0.1", r: "b".repeat(64), w: "c".repeat(64) };
    skills.installOrgSkill(botA, "org:acme/sales-skills@2.0.1", content, stamp);
    migration.migrateBotSkillsToLibrary(botA);

    const entry = library.readSkillLibraryIndex()["org-playbook"]!;
    expect(entry.source).toBe("org:acme/sales-skills@2.0.1");
    expect(entry.package).toEqual(stamp);
    expect(entry.reviewState).toBe("approved"); // org skills arrive switched on
  });

  it("keeps a deduplicated copy whose on/off differs from the library entry", () => {
    const content = SKILL("toggle-review", "Identical bytes.");
    skills.installSkill(botA, "private:test", [{ path: "SKILL.md", content }]);
    skills.setSkillEnabled(botA, "toggle-review", true);
    expect(migration.migrateBotSkillsToLibrary(botA).assignments[botA]).toEqual(["toggle-review"]);
    // Bot B holds the same bytes but switched off: the shared entry is
    // approved, so deduplication would switch the skill on for B.
    skills.installSkill(botB, "private:test", [{ path: "SKILL.md", content }]);
    const reportB = migration.migrateBotSkillsToLibrary(botB);
    expect(reportB.outcomes).toEqual([expect.objectContaining({
      botId: botB,
      name: "toggle-review",
      outcome: "skipped",
      detail: expect.stringContaining("align them before migrating"),
    })]);
    expect(reportB.assignments[botB]).toBeUndefined();
    // The per-bot copy — and its off switch — stays put.
    expect(skills.listSkills(botB).map((skill) => skill.name)).toEqual(["toggle-review"]);
    expect(skills.listSkills(botB)[0]!.enabled).toBe(false);
    expect(existsSync(join(workspaceDir(botB), "skills", "toggle-review", "SKILL.md"))).toBe(true);
  });

  it("records the assignment durably before dropping the manifest entry", () => {
    try {
      skills.installSkill(botA, "private:test", [{ path: "SKILL.md", content: SKILL("durable-assign") }]);
      skills.setSkillEnabled(botA, "durable-assign", true);
      const report = migration.migrateBotSkillsToLibrary(botA);
      expect(report.assignments[botA]).toEqual(["durable-assign"]);
      expect(skills.listSkills(botA)).toEqual([]);
      // The pending file is the recovery record a failed patch replays on
      // the next boot; it must exist before the manifest entry is gone.
      expect(migration.readPendingAssignments()[botA]).toEqual(["durable-assign"]);
    } finally {
      migration.writePendingAssignments({});
    }
  });

  it("keeps the manifest when the assignment cannot be recorded", () => {
    const pendingPath = migration.pendingAssignmentsPath();
    rmSync(pendingPath, { force: true });
    mkdirSync(pendingPath); // a directory where the file must go: the write fails
    try {
      skills.installSkill(botA, "private:test", [{ path: "SKILL.md", content: SKILL("hold-manifest") }]);
      skills.setSkillEnabled(botA, "hold-manifest", true);
      const report = migration.migrateBotSkillsToLibrary(botA);
      // The library install is idempotent and reported first; the failed
      // assignment record then skips the skill before anything is removed.
      expect(report.outcomes.at(-1)).toEqual(expect.objectContaining({
        botId: botA,
        name: "hold-manifest",
        outcome: "skipped",
        detail: expect.stringContaining("could not record the assignment durably"),
      }));
      expect(report.assignments[botA]).toBeUndefined();
      // Nothing was removed, so the next sweep can retry the whole move.
      expect(skills.listSkills(botA).map((skill) => skill.name)).toEqual(["hold-manifest"]);
      // The per-bot copy is still in place and readable, not archived.
      expect(skills.readSkillFile(botA, "hold-manifest")).toContain("# hold-manifest");
      // Once the pending write works again, the retry completes the move.
      rmSync(pendingPath, { recursive: true });
      const retried = migration.migrateBotSkillsToLibrary(botA);
      expect(retried.assignments[botA]).toEqual(["hold-manifest"]);
      expect(skills.listSkills(botA)).toEqual([]);
      expect(migration.readPendingAssignments()[botA]).toEqual(["hold-manifest"]);
    } finally {
      rmSync(pendingPath, { recursive: true, force: true });
      migration.writePendingAssignments({});
    }
  });

  it("flag-off byte-identity: a populated library changes no unassigned bot surface", () => {
    const content = SKILL("flag-off-skill");
    skills.installSkill(botA, "private:test", [{ path: "SKILL.md", content: SKILL("own-skill") }]);
    skills.setSkillEnabled(botA, "own-skill", true);

    const listingBefore = skills.listSkills(botA);
    const promptBefore = skills.skillsSystemPrompt(botA);

    library.installLibrarySkill({ name: "flag-off-skill", instructions: content, source: "lib", reviewState: "approved" });
    library.installLibrarySkill({ name: "own-skill", instructions: SKILL("own-skill", "Library impostor."), source: "lib", reviewState: "approved" });

    // The flag-off paths are exactly the undefined-assignment calls the
    // flag gate in index.ts makes; pin them byte-identical.
    expect(skills.listSkills(botA)).toEqual(listingBefore);
    expect(skills.skillsSystemPrompt(botA)).toBe(promptBefore);
    expect(skills.resolveBotSkills(botA, undefined)).toEqual(listingBefore);
  });
});

describe("skills library boot sweep", () => {
  it("applies script-recorded pending assignments through the patch callback and clears the file", () => {
    skills.installSkill(botA, "private:test", [{ path: "SKILL.md", content: SKILL("pending-skill") }]);
    migration.writePendingAssignments({ [botA]: ["some-already-library-skill"] });
    const bots = [{ id: botA, assignedSkills: undefined as string[] | undefined }];
    const patched: Array<[string, string[]]> = [];
    const report = migration.runSkillsLibraryBootSweep({
      bots,
      patch: (botId, assignedSkills) => {
        patched.push([botId, assignedSkills]);
        bots[0] = { id: botId, assignedSkills };
      },
    });
    expect(patched).toEqual([[botA, ["pending-skill", "some-already-library-skill"]]]);
    expect(report.assignments[botA]).toEqual(["pending-skill", "some-already-library-skill"]);
    expect(migration.readPendingAssignments()).toEqual({});

    // idempotent: nothing left to migrate, nothing changed, no patch call
    const second = migration.runSkillsLibraryBootSweep({
      bots,
      patch: (botId, assignedSkills) => patched.push([botId, assignedSkills]),
    });
    expect(second.outcomes).toEqual([]);
    expect(second.assignments).toEqual({});
    expect(patched.length).toBe(1);
  });

  it("without a patch callback it reports only and leaves pending assignments alone", () => {
    migration.writePendingAssignments({ [botB]: ["held-skill"] });
    migration.runSkillsLibraryBootSweep({ bots: [{ id: botB }] });
    expect(migration.readPendingAssignments()).toEqual({ [botB]: ["held-skill"] });
  });
});
