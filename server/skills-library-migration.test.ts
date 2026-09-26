import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
