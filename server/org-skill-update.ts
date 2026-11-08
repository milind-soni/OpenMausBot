import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson, portableFolderFilesSchema, type PackageSkill } from "../shared/package-format.ts";
import { skillFolderDigest, prepareSkillFolder, writeSkillFolder } from "./skill-folder.ts";
import { directoryEntryState } from "./skill-storage.ts";
import { partHash, skillReleaseValue } from "./package-parts.ts";
import { portableFilesForDisk, snapshotPortableSkill } from "./portable-skill-files.ts";
import { readInstalledSkillBundle } from "./portable-skill-private.ts";
import { retireUnchangedSkillRoot, skillRetirementCapacity, skillRootIdentity } from "./skill-retirement.ts";
import { nativeSkillLinksMayReferTo } from "./skill-native-reference.ts";
import { taskSkillsMayReferTo } from "./skill-task-references.ts";
import { skillMayBeInUse } from "./skill-use-guard.ts";
import { skillUpdateGuardPath, skillUpdateNeedsRecovery } from "./skill-recovery-capacity.ts";
import { orgSkillStorage, type SkillPackageStamp } from "./skills.ts";

const identity = (path: string) => {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink() ? `${stat.dev}:${stat.ino}` : null; } catch { return null; }
};
const fileIdentity = (path: string) => {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 ? `${stat.dev}:${stat.ino}` : null; } catch { return null; }
};

type Options = { writeFolder?: typeof writeSkillFolder; writeManifest?: typeof orgSkillStorage.writeManifest; moveRevision?: typeof renameSync };

/** Resume a committed switch independently of the package stamp, including after a restart. */
export function recoverOrganizationSkillLinks(botId: string, onlyName?: string): { ok: true; pending?: true } | { error: string; retryable: true } {
  const pendingError = (error: string) => ({ error, retryable: true as const });
  const initial = orgSkillStorage.readManifest(botId);
  if (!onlyName) {
    let failure: { error: string; retryable: true } | undefined, pending = false;
    for (const [name, entry] of Object.entries(initial)) {
      if (!entry.pendingRetirements?.length && !entry.pendingRemoval) continue;
      const result = recoverOrganizationSkillLinks(botId, name);
      if ("error" in result) failure ??= result;
      else if (result.pending) pending = true;
    }
    return failure ?? (pending ? { ok: true, pending: true } : { ok: true });
  }
  if (!Object.entries(initial).some(([name, entry]) => name === onlyName && (entry.pendingRetirements?.length || entry.pendingRemoval))) return { ok: true };
  if (skillMayBeInUse(botId)) return pendingError("the bot is still using its skills");
  let stillReferenced = false;
  let recoveryFailure: { error: string; retryable: true } | undefined;
  for (const [name, entry] of Object.entries(initial)) {
    if (onlyName && name !== onlyName) continue;
    if (entry.pendingRemoval) {
      const removed = orgSkillStorage.removeSkill(botId, name);
      if ("error" in removed) return pendingError(removed.error);
      continue;
    }
    const pending = entry.pendingRetirements;
    if (!pending?.length) continue;
    const root = orgSkillStorage.ensureSkillsRoot(botId);
    const current = readInstalledSkillBundle(botId, name);
    if (!root || !entry.source.startsWith("org:") || !entry.package || !entry.storageRevision ||
      pending.some((revision) => revision.revision === entry.storageRevision) || !current ||
      partHash(skillReleaseValue(current)) !== entry.package.w) return pendingError("the current skill changed while its links were being synchronized");
    try {
      if (!orgSkillStorage.syncSkillLinks(botId, { onlyName: name })) {
        return pendingError("the skill's native links could not be switched; retrying with the previous revision retained");
      }
      const afterSync = orgSkillStorage.readManifest(botId)[name], checked = readInstalledSkillBundle(botId, name);
      if (skillMayBeInUse(botId) || !afterSync || canonicalJson(afterSync) !== canonicalJson(entry) || !checked ||
        partHash(skillReleaseValue(checked)) !== entry.package.w) {
        return pendingError("the skill or its use changed while its links were being synchronized");
      }
      const remaining: typeof pending = [];
      const oldDirectories = pending.map((revision) => revision.revision ? join(root, ".revisions", revision.revision) : join(root, name));
      const referenced = taskSkillsMayReferTo(botId, name, oldDirectories);
      for (const [index, revision] of pending.entries()) {
        const oldDirectory = oldDirectories[index]!;
        if (nativeSkillLinksMayReferTo(botId, name, oldDirectory)) {
          return pendingError("the skill's native links could not be switched; retrying with the previous revision retained");
        }
        if (referenced[index]) { remaining.push(revision); continue; }
        const retired = retireUnchangedSkillRoot(oldDirectory, revision, orgSkillStorage.skillStateDir(botId));
        if ("error" in retired) {
          const { recovery: _recovery, ...unchanged } = revision;
          remaining.push({ ...unchanged, recovery: retired.reason === "capacity" ? "capacity" : "attention" });
          recoveryFailure ??= pendingError(retired.error);
          continue;
        }
      }
      const latest = orgSkillStorage.readManifest(botId), now = latest[name];
      if (!now?.pendingRetirements || canonicalJson(now.pendingRetirements) !== canonicalJson(pending) || now.storageRevision !== entry.storageRevision) {
        return pendingError("the skill changed while its links were being synchronized");
      }
      if (canonicalJson(remaining) !== canonicalJson(pending)) {
        if (remaining.length) now.pendingRetirements = remaining; else delete now.pendingRetirements;
        orgSkillStorage.writeManifest(botId, latest);
      }
      if (remaining.length) stillReferenced = true;
    } catch (error) {
      return pendingError(`the skill's links could not be synchronized: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return recoveryFailure ?? (stillReferenced ? { ok: true, pending: true } : { ok: true });
}

/** Stage a complete revision before switching the protected manifest; a failed write leaves the previous revision active. */
export function replaceOrganizationSkill(
  botId: string, source: string, skill: Pick<PackageSkill, "instructions" | "files">,
  stamp: SkillPackageStamp, expected: SkillPackageStamp, options: Options = {},
): { updated: true } | { stale: true } | { error: string; retryable?: boolean } {
  if (!source.startsWith("org:") || (skill.files?.length && !portableFolderFilesSchema.safeParse(skill.files).success)) return { error: "invalid organization skill" };
  if (skillMayBeInUse(botId)) return { error: "the bot is still using its skills; the update will be retried", retryable: true };
  const recovery = recoverOrganizationSkillLinks(botId, stamp.key);
  if ("error" in recovery) return recovery;
  const stored = orgSkillStorage.readManifest(botId)[stamp.key];
  if (process.platform === "win32" && stored?.filesSha256 && !stored.executableFiles) {
    return { error: "the existing Windows skill has no recorded executable intent; its folder needs manual recovery before updating" };
  }
  const folder = prepareSkillFolder([{ path: "SKILL.md", content: skill.instructions }, ...portableFilesForDisk(skill.files ?? [])], undefined, { recordExecutableIntent: true });
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
  const guard = skillUpdateGuardPath(state, stamp.key);
  if (skillUpdateNeedsRecovery(state, stamp.key)) return { error: `a previous skill update needs recovery; inspect ${guard} and the referenced revision before retrying`, retryable: true };
  const before = orgSkillStorage.readManifest(botId), existing = before[stamp.key];
  const currentBefore = readInstalledSkillBundle(botId, stamp.key);
  const previousDirectory = existing && orgSkillStorage.skillDirectory(botId, stamp.key, existing);
  if (!existing?.package || canonicalJson(existing.package) !== canonicalJson(expected) || !currentBefore ||
      partHash(skillReleaseValue(currentBefore)) !== expected.w || !previousDirectory) return { stale: true };
  if ((existing.pendingRetirements?.length ?? 0) >= 32) return { error: "too many previous skill revisions are still in use by task links" };
  const capacity = skillRetirementCapacity(state, previousDirectory);
  if ("error" in capacity) {
    if (existing.recovery !== "capacity") {
      existing.recovery = "capacity";
      try { orgSkillStorage.writeManifest(botId, before); } catch { return { error: capacity.error, retryable: true }; }
    }
    return { error: capacity.error, retryable: true };
  }
  if (existing.recovery === "capacity") {
    delete existing.recovery;
    try { orgSkillStorage.writeManifest(botId, before); } catch { return { error: "the skill recovery status could not be saved", retryable: true }; }
  }
  const revision = createHash("sha256").update(randomUUID()).digest("hex"), target = join(revisions, revision), prepared = join(staging, revision);
  const executableFiles = folder.files.filter((file) => file.executable).map((file) => file.path);
  let published = false, moved = false, preparedId: string | null = null, guardId: string | null = null;
  const outcome = (() : { updated: true } | { stale: true } | { error: string; retryable?: boolean } => { try {
    const fd = openSync(guard, "wx", 0o600);
    try {
      const stat = fstatSync(fd); guardId = `${stat.dev}:${stat.ino}`;
      writeFileSync(fd, JSON.stringify({ revision, target, prepared })); fsyncSync(fd);
    } finally { closeSync(fd); }
    if (fileIdentity(guard) !== guardId || identity(state) !== stateId || identity(staging) !== stagingId) throw new Error("the update recovery marker could not be checked safely");
    (options.writeFolder ?? writeSkillFolder)(prepared, skill.instructions, folder.files, { recordExecutableIntent: true });
    const filesSha256 = skillFolderDigest(prepared, folder.files.map((file) => file.path), { remember: false, executablePaths: executableFiles });
    const staged = snapshotPortableSkill(prepared, () => skill.instructions, undefined, undefined, executableFiles);
    preparedId = identity(prepared);
    if (!filesSha256 || !staged || staged.skipped.length ||
      partHash(skillReleaseValue(staged)) !== partHash(skillReleaseValue(skill)) ||
      !preparedId || identity(state) !== stateId || identity(staging) !== stagingId ||
      identity(root) !== rootId || identity(revisions) !== revisionsId || directoryEntryState(target) !== "missing") throw new Error("the staged skill could not be verified safely");
    (options.moveRevision ?? renameSync)(prepared, target);
    moved = true;
    const transferred = snapshotPortableSkill(target, () => skill.instructions, undefined, undefined, executableFiles);
    if (identity(target) !== preparedId || identity(root) !== rootId || identity(revisions) !== revisionsId ||
      !transferred || transferred.skipped.length || partHash(skillReleaseValue(transferred)) !== partHash(skillReleaseValue(skill))) throw new Error("the staged skill moved through an unsafe path");
    const manifest = orgSkillStorage.readManifest(botId), previous = manifest[stamp.key];
    const current = readInstalledSkillBundle(botId, stamp.key);
    if (!previous?.package || canonicalJson(previous.package) !== canonicalJson(expected) || !current || partHash(skillReleaseValue(current)) !== expected.w) return { stale: true };
    if ((previous.pendingRetirements?.length ?? 0) >= 32) return { error: "too many previous skill revisions are still in use by task links" };
    const oldDirectory = orgSkillStorage.skillDirectory(botId, stamp.key, previous);
    const oldIdentity = oldDirectory && skillRootIdentity(oldDirectory);
    if (!oldDirectory || !oldIdentity) return { stale: true };
    const retiredRoot = previous.storageRevision ? previous.retiredRoot : { identity: oldIdentity, hash: expected.w,
      ...(previous.executableFiles ? { executableFiles: [...previous.executableFiles] } : {}) };
    const { referencesSha256: _references, files: _files, filesSha256: _digest, executableFiles: _executable, storageRevision: _revision,
      appliedStageId: _stage, github: _github, retiredRoot: _retiredRoot, pendingRetirements: _pending, ...rest } = previous;
    manifest[stamp.key] = { ...rest, source, description: folder.parsed.description, sha256: createHash("sha256").update(skill.instructions).digest("hex"),
      importedAt: new Date().toISOString(), license: folder.parsed.license, compatibility: folder.parsed.compatibility,
      warnings: folder.warnings, skippedFiles: [], storageRevision: revision, package: { ...stamp },
      pendingRetirements: [...(previous.pendingRetirements ?? []), { identity: oldIdentity, hash: expected.w, ...(previous.storageRevision ? { revision: previous.storageRevision } : {}),
        ...(previous.executableFiles ? { executableFiles: [...previous.executableFiles] } : {}) }],
      ...(retiredRoot ? { retiredRoot } : {}),
      ...(folder.files.length ? { files: folder.files.map((file) => file.path), filesSha256, executableFiles } : {}) };
    (options.writeManifest ?? orgSkillStorage.writeManifest)(botId, manifest);
    published = true;
    const switched = recoverOrganizationSkillLinks(botId, stamp.key);
    return "error" in switched ? switched : { updated: true };
  } catch (error) {
    if (published) return { error: `the skill's links need recovery: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
    if ((error as NodeJS.ErrnoException | null)?.code === "EXDEV") return { error: "skill update was not applied: workspace and protected skill storage are on different filesystems" };
    return { error: `skill update was not applied: ${error instanceof Error ? error.message : String(error)}` };
  } })();
  let cleanupError: string | undefined;
  if (!published) {
    if (identity(state) !== stateId || identity(staging) !== stagingId) cleanupError = "the protected staging path changed";
    else {
      try { rmSync(prepared, { recursive: true, force: true }); } catch { cleanupError = "the staged folder could not be cleared"; }
      if (moved) {
        const targetIdentity = identity(target) === preparedId ? skillRootIdentity(target) : null;
        if (!targetIdentity) cleanupError = "the uncommitted revision could not be checked safely";
        else {
          const retired = retireUnchangedSkillRoot(target, { identity: targetIdentity, hash: partHash(skillReleaseValue(skill)), executableFiles }, state);
          if ("error" in retired) cleanupError = retired.error;
        }
      }
    }
  }
  if (!cleanupError && guardId) {
    try {
      if (identity(state) !== stateId || identity(staging) !== stagingId || fileIdentity(guard) !== guardId) throw new Error("marker changed");
      unlinkSync(guard);
    } catch { cleanupError = "the update recovery marker could not be cleared safely"; }
  }
  if (cleanupError) return { error: `${cleanupError}. Skill update recovery marker: ${guard}; revision: ${target}; recovery folder: ${join(state, "retired-roots")}. See the organization library recovery guide.`, retryable: true };
  return outcome;
}
