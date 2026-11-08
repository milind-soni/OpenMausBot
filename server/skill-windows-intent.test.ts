import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { recoverOrganizationSkillLinks, replaceOrganizationSkill } from "./org-skill-update.ts";
import { pair, skillReleaseValue } from "./package-parts.ts";
import { exportPrivateSkill, readInstalledSkillBundle } from "./portable-skill-private.ts";
import { skillFolderDigest } from "./skill-folder.ts";
import { installOrgSkill, installSkill, listSkills, orgSkillStorage, removeSkill, setSkillEnabled } from "./skills.ts";
import { exportLibrarySkill, installLibrarySkill, readSkillLibraryIndex, setLibrarySkillReviewState } from "./skill-library.ts";
import { workspaceDir } from "./workspace.ts";
import { setSkillUseGuard } from "./skill-use-guard.ts";
import { ensureTaskWorkspaceWithSkills } from "./skill-task-links.ts";
import { exportImportedSkill, IMPORTED_SKILLS_DIR, storeImportedSkills } from "./imported-skills.ts";
import { removeOrganizationSkill } from "./skill-org-removal.ts";
import { retireUnchangedSkillRoot } from "./skill-retirement.ts";

const bot = `win-intent-${randomUUID()}`;
const name = "reviewed-intent";
const library = join(DATA_DIR, `win-intent-library-${randomUUID()}`);
const instructions = `---\nname: ${name}\ndescription: A reviewed fixture.\n---\n\nRead the guide.\n`;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const simulateWindows = <T>(fn: () => T): T => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try { return fn(); } finally { Object.defineProperty(process, "platform", platform); }
};

afterEach(() => {
  if (!DATA_DIR.startsWith(join(tmpdir(), "omb-test-home-"))) throw new Error(`refusing to clean ${DATA_DIR}: not this test's home`);
  rmSync(workspaceDir(bot), { recursive: true, force: true });
  rmSync(join(DATA_DIR, "skill-state", bot), { recursive: true, force: true });
  rmSync(join(DATA_DIR, "task-workspaces", bot), { recursive: true, force: true });
  rmSync(library, { recursive: true, force: true });
  rmSync(IMPORTED_SKILLS_DIR, { recursive: true, force: true });
  rmSync(join(DATA_DIR, "skill-state", "imported-skills.json"), { force: true });
});

describe("reviewed executable intent on Windows", () => {
  it("round-trips stored intent and bytes, rejects tampering, and does not infer legacy intent", () => simulateWindows(() => {
    const files = [
      { path: "SKILL.md", content: instructions },
      { path: "scripts/run.sh", content: "#!/bin/sh\necho fixture\n", executable: true },
      { path: "references/guide.md", content: "Reviewed guide.\n" },
      { path: "assets/sample.bin", content: Buffer.from([0, 255, 1]) },
    ];
    expect(installSkill(bot, "fixture", files)).toMatchObject({ enabled: false });
    let manifest = orgSkillStorage.readManifest(bot), entry = manifest[name]!;
    expect(entry.executableFiles).toEqual(["scripts/run.sh"]);
    const directory = orgSkillStorage.skillDirectory(bot, name, entry)!;
    expect(statSync(join(directory, "scripts", "run.sh")).mode & 0o100).toBe(0);
    expect(setSkillEnabled(bot, name, true)).toMatchObject({ enabled: true });
    const exported = exportPrivateSkill(bot, name)!;
    expect(exported.files).toContainEqual({ path: "scripts/run.sh", content: "#!/bin/sh\necho fixture\n", executable: true });
    expect(exported.files).toContainEqual({ path: "assets/sample.bin", binary: { base64: "AP8B" } });

    manifest = orgSkillStorage.readManifest(bot);
    manifest[name]!.executableFiles = [];
    orgSkillStorage.writeManifest(bot, manifest);
    expect(listSkills(bot)[0]!.enabled).toBe(false);
    expect(exportPrivateSkill(bot, name)).toBeNull();
    delete manifest[name]!.executableFiles;
    orgSkillStorage.writeManifest(bot, manifest);
    expect(listSkills(bot)[0]!.enabled).toBe(false);
    manifest[name]!.executableFiles = ["scripts/run.sh", "scripts/run.sh"];
    orgSkillStorage.writeManifest(bot, manifest);
    expect(listSkills(bot)[0]!.enabled).toBe(false);
    manifest[name]!.executableFiles = ["scripts/run.sh"];
    orgSkillStorage.writeManifest(bot, manifest);
    writeFileSync(join(directory, "scripts", "run.sh"), "changed after review\n");
    expect(listSkills(bot)[0]!.enabled).toBe(false);
    expect(exportPrivateSkill(bot, name)).toBeNull();

    writeFileSync(join(directory, "scripts", "run.sh"), "#!/bin/sh\necho fixture\n");
    manifest = orgSkillStorage.readManifest(bot); entry = manifest[name]!;
    delete entry.executableFiles;
    entry.filesSha256 = skillFolderDigest(directory, entry.files!, { remember: false })!;
    orgSkillStorage.writeManifest(bot, manifest);
    expect(listSkills(bot)[0]!.enabled).toBe(true);
    expect(exportPrivateSkill(bot, name)).toBeNull();
  }));

  it("does not guess the mode of a welcome-imported Windows folder", () => simulateWindows(() => {
    const source = join(DATA_DIR, "source");
    const input = { name, skillMd: instructions, files: [{ path: "scripts/run.sh", content: "echo fixture\n", executable: false }], entry: {
      description: "fixture", source: "codex" as const, root: source, origin: join(source, name), label: "fixture",
      sha256: createHash("sha256").update(instructions).digest("hex"), warnings: [],
    } };
    expect(storeImportedSkills([input])).toEqual([expect.objectContaining({ stored: true })]);
    expect(readFileSync(join(IMPORTED_SKILLS_DIR, name, "scripts", "run.sh"), "utf8")).toBe("echo fixture\n");
    expect(storeImportedSkills([{ ...input, files: [{ ...input.files[0]!, executable: true }] }])).toEqual([expect.objectContaining({ stored: false })]);
    expect(readFileSync(join(IMPORTED_SKILLS_DIR, name, "scripts", "run.sh"), "utf8")).toBe("echo fixture\n");
    expect(exportImportedSkill(name)).toBeNull();
  }));

  it("retains intent in the library index without enabling an unreviewed skill", () => simulateWindows(() => {
    const files = [{ path: "scripts/run.sh", content: "#!/bin/sh\necho fixture\n", executable: true }];
    expect(installLibrarySkill({ name, instructions, source: "fixture", files, root: library })).toMatchObject({ enabled: false });
    expect(readSkillLibraryIndex(library)[name]!.executableFiles).toEqual(["scripts/run.sh"]);
    expect(setLibrarySkillReviewState(name, "approved", library)).toMatchObject({ enabled: true });
    expect(exportLibrarySkill(name, library)!.files).toContainEqual(files[0]);
    writeFileSync(join(library, "skills", name, "scripts", "run.sh"), "changed after review\n");
    expect(exportLibrarySkill(name, library)).toBeNull();
    expect(setLibrarySkillReviewState(name, "approved", library)).toHaveProperty("error");
  }));

  it("does not trust executable metadata supplied by a workspace-authored legacy manifest", () => simulateWindows(() => {
    const root = join(workspaceDir(bot), "skills"), directory = join(root, name);
    mkdirSync(join(directory, "scripts"), { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), instructions);
    writeFileSync(join(directory, "scripts", "run.sh"), "fixture\n", { mode: 0o600 });
    const files = ["scripts/run.sh"], filesSha256 = skillFolderDigest(directory, files, { remember: false })!;
    writeFileSync(join(root, "skills.json"), JSON.stringify({ [name]: {
      description: "fixture", enabled: true, source: "legacy:fixture", sha256: createHash("sha256").update(instructions).digest("hex"),
      importedAt: "2026-01-01T00:00:00Z", warnings: [], skippedFiles: [], files, filesSha256, executableFiles: files,
    } }));
    expect(listSkills(bot)[0]!.enabled).toBe(false);
    expect(orgSkillStorage.readManifest(bot)[name]!.executableFiles).toBeUndefined();
    expect(setSkillEnabled(bot, name, true)).toMatchObject({ enabled: true });
    expect(exportPrivateSkill(bot, name)).toBeNull();
  }));

  it("keeps the legacy text-only release hash and update behavior", () => simulateWindows(() => {
    setSkillUseGuard(() => false);
    const first = { instructions }, next = { instructions: `${instructions}Updated.\n` };
    const stamp = (release: string, skill: typeof first) => ({ installId: "a".repeat(32), key: name, release, ...pair(skillReleaseValue(skill), skillReleaseValue(skill)) });
    const before = stamp("1.0.0", first), after = stamp("1.1.0", next);
    expect(before.w).toBe(createHash("sha256").update(JSON.stringify(instructions)).digest("hex"));
    expect(installOrgSkill(bot, "org:fixture", first.instructions, before)).toMatchObject({ enabled: true });
    expect(replaceOrganizationSkill(bot, "org:fixture", next, after, before)).toEqual({ updated: true });
    expect(readInstalledSkillBundle(bot, name)).toEqual(next);
    expect(removeSkill(bot, name)).toEqual({ removed: true });
  }));

  it("removes an unchanged unstamped organization-source folder with reviewed mode metadata", () => simulateWindows(() => {
    setSkillUseGuard(() => false);
    expect(installSkill(bot, "org:fixture@1.0.0", [{ path: "SKILL.md", content: instructions },
      { path: "scripts/run.sh", content: "echo fixture\n", executable: true }])).toMatchObject({ enabled: false });
    expect(setSkillEnabled(bot, name, true)).toMatchObject({ enabled: true });
    const entry = orgSkillStorage.readManifest(bot)[name]!, directory = orgSkillStorage.skillDirectory(bot, name, entry)!;
    expect(entry.package).toBeUndefined();
    expect(removeSkill(bot, name)).toEqual({ removed: true });
    expect(existsSync(directory)).toBe(false);
  }));

  it("keeps a legacy organization bundle when executable intent is unavailable", () => simulateWindows(() => {
    setSkillUseGuard(() => false);
    const skill = { instructions, files: [{ path: "scripts/run.sh", content: "echo fixture\n" }] };
    const stamp = (release: string) => ({ installId: "a".repeat(32), key: name, release, ...pair(skillReleaseValue(skill), skillReleaseValue(skill)) });
    expect(installOrgSkill(bot, "org:fixture", instructions, stamp("1.0.0"), skill.files)).toMatchObject({ enabled: true });
    const manifest = orgSkillStorage.readManifest(bot), directory = orgSkillStorage.skillDirectory(bot, name, manifest[name]!)!;
    delete manifest[name]!.executableFiles;
    orgSkillStorage.writeManifest(bot, manifest);
    expect(replaceOrganizationSkill(bot, "org:fixture", skill, stamp("1.1.0"), stamp("1.0.0"))).toHaveProperty("error", expect.stringContaining("no recorded executable intent"));
    expect(removeSkill(bot, name)).toHaveProperty("error", expect.stringContaining("no recorded executable intent"));
    expect(readFileSync(join(directory, "scripts", "run.sh"), "utf8")).toBe("echo fixture\n");
    expect(listSkills(bot)[0]!.enabled).toBe(true);
  }));

  it("keeps mode metadata with a task-pinned previous revision until recovery", () => simulateWindows(() => {
    setSkillUseGuard(() => false);
    const first = { instructions, files: [{ path: "scripts/run.sh", content: "echo previous\n", executable: true as const }] };
    const next = { instructions, files: [{ path: "scripts/run.sh", content: "echo current\n" }] };
    const stamp = (release: string, skill: typeof first | typeof next) => ({ installId: "a".repeat(32), key: name, release, ...pair(skillReleaseValue(skill), skillReleaseValue(skill)) });
    const before = stamp("1.0.0", first), after = stamp("1.1.0", next);
    expect(installOrgSkill(bot, "org:fixture", first.instructions, before, first.files)).toMatchObject({ enabled: true });
    const folder = ensureTaskWorkspaceWithSkills(bot, "task-one"), taskFile = join(folder, ".claude", "skills", name, "scripts", "run.sh");
    const old = orgSkillStorage.skillDirectory(bot, name, orgSkillStorage.readManifest(bot)[name]!)!;
    expect(replaceOrganizationSkill(bot, "org:fixture", next, after, before)).toEqual({ updated: true });
    expect(readFileSync(taskFile, "utf8")).toBe("echo previous\n");
    expect(orgSkillStorage.readManifest(bot)[name]!.pendingRetirements).toEqual([expect.objectContaining({ executableFiles: ["scripts/run.sh"] })]);
    ensureTaskWorkspaceWithSkills(bot, "task-one");
    expect(readFileSync(taskFile, "utf8")).toBe("echo current\n");
    expect(recoverOrganizationSkillLinks(bot, name)).toEqual({ ok: true });
    expect(existsSync(old)).toBe(false);
  }));

  it("retains a partially deleted executable bundle and its mode metadata for recovery", () => simulateWindows(() => {
    setSkillUseGuard(() => false);
    const skill = { instructions, files: [{ path: "scripts/run.sh", content: "echo keep\n", executable: true as const }] };
    const stamp = { installId: "a".repeat(32), key: name, release: "1.0.0", ...pair(skillReleaseValue(skill), skillReleaseValue(skill)) };
    expect(installOrgSkill(bot, "org:fixture", instructions, stamp, skill.files)).toMatchObject({ enabled: true });
    const result = removeOrganizationSkill(bot, name, orgSkillStorage, { retire: (directory, expected, state) =>
      retireUnchangedSkillRoot(directory, expected, state, { remove: (moved) => { rmSync(join(String(moved), "SKILL.md")); throw new Error("partial deletion"); } }) });
    expect(result).toHaveProperty("error", expect.stringContaining("still needs cleanup"));
    const pending = orgSkillStorage.readManifest(bot)[name]!;
    expect(pending).toMatchObject({ enabled: false, pendingRemoval: { executableFiles: ["scripts/run.sh"] } });
    expect(recoverOrganizationSkillLinks(bot, name)).toHaveProperty("error", expect.stringContaining("still needs cleanup"));
    expect(orgSkillStorage.readManifest(bot)[name]!.pendingRemoval).toEqual(pending.pendingRemoval);
  }));

  it("preserves executable intent through organization updates, failed staging and removal", () => simulateWindows(() => {
    setSkillUseGuard(() => false);
    const first = { instructions, files: [{ path: "scripts/run.sh", content: "#!/bin/sh\necho fixture\n", executable: true as const }] };
    const next = { instructions, files: [{ path: "scripts/run.sh", content: "#!/bin/sh\necho fixture\n" }] };
    const stamp = (release: string, skill: typeof first | typeof next) => ({ installId: "a".repeat(32), key: name, release, ...pair(skillReleaseValue(skill), skillReleaseValue(skill)) });
    const before = stamp("1.0.0", first), after = stamp("1.1.0", next);
    expect(installOrgSkill(bot, "org:fixture", first.instructions, before, first.files)).toMatchObject({ enabled: true });
    expect(readInstalledSkillBundle(bot, name)).toEqual(first);
    expect(setSkillEnabled(bot, name, false)).toMatchObject({ enabled: false });
    const old = orgSkillStorage.skillDirectory(bot, name, orgSkillStorage.readManifest(bot)[name]!)!;
    const failed = replaceOrganizationSkill(bot, "org:fixture", next, after, before, { writeManifest: () => { throw new Error("fixture disk failure"); } });
    expect(failed).toHaveProperty("error");
    expect(readInstalledSkillBundle(bot, name)).toEqual(first);
    expect(listSkills(bot)[0]!.enabled).toBe(false);
    writeFileSync(join(old, "scripts", "run.sh"), "local edit\n");
    expect(replaceOrganizationSkill(bot, "org:fixture", next, after, before)).toEqual({ stale: true });
    expect(readFileSync(join(old, "scripts", "run.sh"), "utf8")).toBe("local edit\n");
    writeFileSync(join(old, "scripts", "run.sh"), first.files[0]!.content);
    expect(replaceOrganizationSkill(bot, "org:fixture", next, after, before)).toEqual({ updated: true });
    expect(readInstalledSkillBundle(bot, name)).toEqual(next);
    expect(orgSkillStorage.readManifest(bot)[name]!.executableFiles).toEqual([]);
    expect(listSkills(bot)[0]!.enabled).toBe(false);
    expect(existsSync(old)).toBe(false);
    expect(removeSkill(bot, name)).toEqual({ removed: true });
    expect(orgSkillStorage.readManifest(bot)[name]).toBeUndefined();
  }));
});
