import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson, skillCompanionsSchema, type PackageSkill } from "../shared/package-format.ts";
import { skillFolderDigest, prepareSkillFolder, writeSkillFolder } from "./skill-folder.ts";
import { directoryEntryState } from "./skill-storage.ts";
import { partHash, skillReleaseValue } from "./package-parts.ts";
import { snapshotPortableSkill } from "./portable-skill-files.ts";
import { readInstalledSkillBundle } from "./portable-skill-private.ts";
import { retireUnchangedSkillRoot, skillRootIdentity } from "./skill-retirement.ts";
import { orgSkillStorage, type SkillPackageStamp } from "./skills.ts";

const identity = (path: string) => {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink() ? `${stat.dev}:${stat.ino}` : null; } catch { return null; }
};

type Options = { writeFolder?: typeof writeSkillFolder; writeManifest?: typeof orgSkillStorage.writeManifest };

/** Stage a complete revision before switching the protected manifest; a failed write leaves the previous revision active. */
export function replaceOrganizationSkill(
  botId: string, source: string, skill: Pick<PackageSkill, "instructions" | "files">,
  stamp: SkillPackageStamp, expected: SkillPackageStamp, options: Options = {},
): { updated: true } | { stale: true } | { error: string } {
  if (!source.startsWith("org:") || (skill.files?.length && !skillCompanionsSchema.safeParse(skill.files).success)) return { error: "invalid organization skill" };
  const folder = prepareSkillFolder([{ path: "SKILL.md", content: skill.instructions }, ...(skill.files ?? [])]);
  if ("error" in folder) return folder;
  if (folder.skipped.length || folder.parsed.name !== stamp.key || stamp.key !== expected.key) return { error: "invalid organization skill files" };
  const root = orgSkillStorage.ensureSkillsRoot(botId);
  if (!root) return { error: "the workspace skills path is not a real directory" };
  const revisions = join(root, ".revisions");
  if (directoryEntryState(revisions) === "missing") {
    try { mkdirSync(revisions, { mode: 0o700 }); } catch { return { error: "could not create the skill revision directory" }; }
  }
  const rootId = identity(root), revisionsId = identity(revisions);
  if (!rootId || !revisionsId) return { error: "the skill revision path is not a real directory" };
  const state = orgSkillStorage.skillStateDir(botId), stateId = identity(state), staging = join(state, "org-skill-staging");
  if (!stateId) return { error: "the protected skill state path is not a real directory" };
  if (directoryEntryState(staging) === "missing") {
    try { mkdirSync(staging, { mode: 0o700 }); } catch { return { error: "could not create the protected staging directory" }; }
  }
  const stagingId = identity(staging);
  if (!stagingId) return { error: "the protected staging path is not a real directory" };
  const revision = createHash("sha256").update(randomUUID()).digest("hex"), target = join(revisions, revision), prepared = join(staging, revision);
  let published = false, moved = false, preparedId: string | null = null;
  try {
    (options.writeFolder ?? writeSkillFolder)(prepared, skill.instructions, folder.files);
    const filesSha256 = skillFolderDigest(prepared, folder.files.map((file) => file.path), { remember: false });
    const staged = snapshotPortableSkill(prepared, () => skill.instructions);
    preparedId = identity(prepared);
    if (!filesSha256 || !staged || staged.skipped.length ||
      partHash(skillReleaseValue(staged)) !== partHash(skillReleaseValue(skill)) ||
      !preparedId || identity(state) !== stateId || identity(staging) !== stagingId ||
      identity(root) !== rootId || identity(revisions) !== revisionsId || directoryEntryState(target) !== "missing") throw new Error("the staged skill could not be verified safely");
    renameSync(prepared, target);
    moved = true;
    const transferred = snapshotPortableSkill(target, () => skill.instructions);
    if (identity(target) !== preparedId || identity(root) !== rootId || identity(revisions) !== revisionsId ||
      !transferred || transferred.skipped.length || partHash(skillReleaseValue(transferred)) !== partHash(skillReleaseValue(skill))) throw new Error("the staged skill moved through an unsafe path");
    const manifest = orgSkillStorage.readManifest(botId), previous = manifest[stamp.key];
    const current = readInstalledSkillBundle(botId, stamp.key);
    if (!previous?.package || canonicalJson(previous.package) !== canonicalJson(expected) || !current || partHash(skillReleaseValue(current)) !== expected.w) return { stale: true };
    const oldDirectory = orgSkillStorage.skillDirectory(botId, stamp.key, previous);
    const oldIdentity = oldDirectory && skillRootIdentity(oldDirectory);
    if (!oldDirectory || !oldIdentity) return { stale: true };
    const retiredRoot = previous.storageRevision ? previous.retiredRoot : { identity: oldIdentity, hash: expected.w };
    const { referencesSha256: _references, files: _files, filesSha256: _digest, storageRevision: _revision,
      appliedStageId: _stage, github: _github, retiredRoot: _retiredRoot, ...rest } = previous;
    manifest[stamp.key] = { ...rest, source, description: folder.parsed.description, sha256: createHash("sha256").update(skill.instructions).digest("hex"),
      importedAt: new Date().toISOString(), license: folder.parsed.license, compatibility: folder.parsed.compatibility,
      warnings: folder.warnings, skippedFiles: [], storageRevision: revision, package: { ...stamp },
      ...(retiredRoot ? { retiredRoot } : {}),
      ...(folder.files.length ? { files: folder.files.map((file) => file.path), filesSha256 } : {}) };
    (options.writeManifest ?? orgSkillStorage.writeManifest)(botId, manifest);
    published = true;
    orgSkillStorage.syncSkillLinks(botId);
    if (identity(root) === rootId && identity(revisions) === revisionsId && skillRootIdentity(oldDirectory) === oldIdentity && orgSkillStorage.skillContentMatches(botId, stamp.key, previous)) {
      retireUnchangedSkillRoot(oldDirectory, { identity: oldIdentity, hash: expected.w }, orgSkillStorage.skillStateDir(botId));
    }
    return { updated: true };
  } catch (error) {
    if (published) return { updated: true };
    return { error: `skill update was not applied: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (!published && identity(state) === stateId && identity(staging) === stagingId) {
      try { rmSync(prepared, { recursive: true, force: true }); } catch {}
      const targetIdentity = moved && identity(target) === preparedId ? skillRootIdentity(target) : null;
      if (targetIdentity) retireUnchangedSkillRoot(target, { identity: targetIdentity, hash: partHash(skillReleaseValue(skill)) }, state);
    }
  }
}
