// Skill storage layout and protected state — the workspace skills root
// and revision directories, the DATA_DIR manifest and managed-link
// records, content-integrity checks, and the native-discovery links
// projected from the manifest.

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { workspaceDir } from "../workspace.ts";
import { isSkillName } from "./text.ts";

export interface SkillManifestEntry {
  description: string;
  enabled: boolean;
  source: string;
  sha256: string;
  importedAt: string;
  license?: string;
  compatibility?: string;
  warnings: string[];
  skippedFiles: string[];
  /** Makes approval replay safe if the process stops after promotion but
   * before the confirmation card is durably settled. Never exposed to agents. */
  appliedStageId?: string;
  /** Immutable workspace revision selected by the protected manifest. Older
   * skills omit this and continue to use skills/<name>. */
  storageRevision?: string;
}

interface SkillManifest {
  [name: string]: SkillManifestEntry;
}

const skillManifestEntrySchema = z.object({
  description: z.string(),
  enabled: z.boolean(),
  source: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  importedAt: z.string(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  warnings: z.array(z.string()),
  skippedFiles: z.array(z.string()),
  appliedStageId: z.string().optional(),
  storageRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
const skillManifestSchema = z.record(z.string(), skillManifestEntrySchema);
const managedLinksSchema = z.array(z.string());

export function skillsDir(botId: string): string {
  return join(workspaceDir(botId), "skills");
}

type DirectoryEntryState = "missing" | "directory" | "unsafe";

export function directoryEntryState(path: string): DirectoryEntryState {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "unsafe";
  } catch {
    return "missing";
  }
}

export function existingSkillsRoot(botId: string): string | null {
  const root = skillsDir(botId);
  return directoryEntryState(root) === "directory" ? root : null;
}

export function ensureSkillsRoot(botId: string): string | null {
  const root = skillsDir(botId);
  const state = directoryEntryState(root);
  if (state === "unsafe") return null;
  if (state === "missing") {
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch {
      return null;
    }
  }
  return directoryEntryState(root) === "directory" ? root : null;
}

export function existingSkillDirectory(botId: string, name: string): string | null {
  const root = existingSkillsRoot(botId);
  if (!root) return null;
  const directory = join(root, name);
  return directoryEntryState(directory) === "directory" ? directory : null;
}

export function skillDirectory(botId: string, name: string, entry: SkillManifestEntry): string | null {
  if (!entry.storageRevision) return existingSkillDirectory(botId, name);
  const root = existingSkillsRoot(botId);
  if (!root) return null;
  const revisions = join(root, ".revisions");
  if (directoryEntryState(revisions) !== "directory") return null;
  const directory = join(revisions, entry.storageRevision);
  return directoryEntryState(directory) === "directory" ? directory : null;
}

export function skillTarget(root: string, name: string, entry: SkillManifestEntry): string {
  return entry.storageRevision
    ? join(root, "skills", ".revisions", entry.storageRevision)
    : join(root, "skills", name);
}

export function entryExistsWithoutFollowing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Native discovery has two app-created levels (`.claude/skills`, etc.).
 * Check each without following symlinks before scanning or creating below it. */
function nativeLinkDirectory(root: string, relative: string, create: boolean): string | null {
  const [family, leaf] = relative.split("/");
  if (!family || !leaf) return null;
  const familyDir = join(root, family);
  let familyState = directoryEntryState(familyDir);
  if (familyState === "missing" && create) {
    try {
      mkdirSync(familyDir, { mode: 0o700 });
    } catch {
      return null;
    }
    familyState = directoryEntryState(familyDir);
  }
  if (familyState !== "directory") return null;

  const linkDir = join(familyDir, leaf);
  let linkState = directoryEntryState(linkDir);
  if (linkState === "missing" && create) {
    try {
      mkdirSync(linkDir, { mode: 0o700 });
    } catch {
      return null;
    }
    linkState = directoryEntryState(linkDir);
  }
  return linkState === "directory" ? linkDir : null;
}

/** Approval and enablement state stays outside the bot's working directory.
 * The skill text is readable in the workspace; the control record is not a
 * file the agent is expected to edit as part of ordinary work. */
export function skillStateDir(botId: string): string {
  return join(DATA_DIR, "skill-state", botId);
}

function manifestPath(botId: string): string {
  return join(skillStateDir(botId), "skills.json");
}

function managedLinksPath(botId: string): string {
  return join(skillStateDir(botId), "managed-links.json");
}

function readManagedLinks(botId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(managedLinksPath(botId), "utf8"));
    const result = managedLinksSchema.safeParse(parsed);
    return result.success ? result.data.filter(isSkillName) : [];
  } catch {
    return [];
  }
}

function writeManagedLinks(botId: string, names: string[]): void {
  mkdirSync(skillStateDir(botId), { recursive: true, mode: 0o700 });
  writeFileAtomic(managedLinksPath(botId), `${JSON.stringify([...new Set(names)].sort(), null, 2)}\n`, { mode: 0o600 });
}

function manifestFromFile(path: string): SkillManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const result = skillManifestSchema.safeParse(parsed);
    if (!result.success) return null;
    const manifest: SkillManifest = {};
    for (const [name, entry] of Object.entries(result.data)) {
      if (isSkillName(name)) manifest[name] = entry;
    }
    return manifest;
  } catch {
    return null;
  }
}

export function readManifest(botId: string): SkillManifest {
  const securePath = manifestPath(botId);
  // Existence is the migration marker. If protected state is corrupt, fail
  // closed instead of falling back to an agent-writable legacy manifest.
  if (existsSync(securePath)) return manifestFromFile(securePath) ?? {};

  const legacyRoot = existingSkillsRoot(botId);
  if (!legacyRoot) return {};
  const legacyPath = join(legacyRoot, "skills.json");
  if (!existsSync(legacyPath)) return {};
  const legacy = manifestFromFile(legacyPath) ?? {};
  const migrated: SkillManifest = {};
  for (const [name, entry] of Object.entries(legacy)) {
    // Legacy state lived inside the bot workspace. Preserve metadata, but no
    // workspace-authored bit may silently carry enablement into secure state.
    const {
      appliedStageId: _appliedStageId,
      storageRevision: _storageRevision,
      ...visible
    } = entry;
    migrated[name] = { ...visible, enabled: false };
  }
  writeManifest(botId, migrated);
  try {
    rmSync(legacyPath, { force: true });
  } catch {
    // The secure file now exists and always wins; stale legacy bytes are inert.
  }
  return migrated;
}

function comparablePath(path: string): string {
  const normalized = resolve(path).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** True only for a symlink/junction whose target is this exact bot skill.
 * The readlink fallback also recognizes a broken app link without following
 * it, while never claiming a user-owned directory or an unrelated symlink. */
function nativeLinkPointsToSkill(link: string, target: string): boolean {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
    try {
      return comparablePath(realpathSync(link)) === comparablePath(realpathSync(target));
    } catch {
      const rawTarget = readlinkSync(link);
      const resolvedTarget = resolve(dirname(link), rawTarget.replace(/^\\\\\?\\/, ""));
      return comparablePath(resolvedTarget) === comparablePath(target);
    }
  } catch {
    return false;
  }
}

/** Recognize only app storage targets without following them: skills/<name>
 * from older releases, or one content revision under skills/.revisions/. */
function nativeLinkDirectlyTargetsOwnedSkill(
  link: string,
  root: string,
  name: string,
  revisionWasManaged: boolean,
  targetBaseDirectory = dirname(link),
): boolean {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
    const rawTarget = readlinkSync(link);
    const resolvedTarget = resolve(targetBaseDirectory, rawTarget.replace(/^\\\\\?\\/, ""));
    const insideSkills = relative(join(root, "skills"), resolvedTarget).replaceAll("\\", "/");
    return insideSkills === name || (revisionWasManaged && /^\.revisions\/[a-f0-9]{64}$/.test(insideSkills));
  } catch {
    return false;
  }
}

type NativeLinkRemoval = "removed" | "preserved" | "retry";

/** Move one exact directory entry aside before deciding whether it is ours.
 * `renameSync` is the identity boundary: a workspace process may replace the
 * original name at any time, but it cannot change which entry was moved. */
function removeOwnedNativeLink(
  botId: string,
  link: string,
  root: string,
  name: string,
  revisionWasManaged: boolean,
  beforeRemove?: (link: string) => void,
): NativeLinkRemoval {
  const quarantineDir = join(skillStateDir(botId), "link-removal");
  try {
    mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  } catch {
    return "retry";
  }
  const quarantined = join(quarantineDir, randomUUID());
  beforeRemove?.(link);
  try {
    renameSync(link, quarantined);
  } catch {
    return nativeLinkDirectlyTargetsOwnedSkill(link, root, name, revisionWasManaged)
      ? "retry"
      : "preserved";
  }

  if (nativeLinkDirectlyTargetsOwnedSkill(
    quarantined,
    root,
    name,
    revisionWasManaged,
    dirname(link),
  )) {
    try {
      unlinkSync(quarantined);
      return "removed";
    } catch {
      try {
        if (!entryExistsWithoutFollowing(link)) renameSync(quarantined, link);
      } catch {}
      return "retry";
    }
  }

  try {
    if (!entryExistsWithoutFollowing(link)) renameSync(quarantined, link);
  } catch {}
  return "preserved";
}

export function writeManifest(botId: string, manifest: SkillManifest): void {
  mkdirSync(skillStateDir(botId), { recursive: true, mode: 0o700 });
  writeFileAtomic(manifestPath(botId), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

/** The native discovery dirs of the CLIs bots run. A skill enabled here is
 * linked into each, inside the workspace, so engines with first-class skill
 * support load it themselves with their own progressive disclosure. */
const NATIVE_SKILL_DIRS = [".claude/skills", ".agents/skills", ".grok/skills"];

/** Revoke native links without following an unsafe `skills/` root. An enabled
 * app link otherwise starts resolving into the bot-controlled replacement.
 * Compare the link text, not its real path, so a user-replaced same-name link
 * remains untouched. */
function removeNativeLinksForUnsafeSkillsRoot(
  botId: string,
  root: string,
  previouslyManaged: string[],
  beforeRemove?: (link: string) => void,
): void {
  const retry = new Set<string>();
  for (const dir of NATIVE_SKILL_DIRS) {
    const linkDir = nativeLinkDirectory(root, dir, false);
    if (!linkDir) {
      // The directory may become safe again later, so retain the registry as
      // a cleanup hint without following its current replacement.
      for (const name of previouslyManaged) retry.add(name);
      continue;
    }
    let existing: string[];
    try {
      existing = readdirSync(linkDir).filter(isSkillName);
    } catch {
      for (const name of previouslyManaged) retry.add(name);
      continue;
    }
    for (const name of new Set([...existing, ...previouslyManaged])) {
      const link = join(linkDir, name);
      if (!nativeLinkDirectlyTargetsOwnedSkill(link, root, name, previouslyManaged.includes(name))) continue;
      const result = removeOwnedNativeLink(
        botId,
        link,
        root,
        name,
        previouslyManaged.includes(name),
        beforeRemove,
      );
      if (result === "retry") retry.add(name);
    }
  }
  try {
    writeManagedLinks(botId, [...retry]);
  } catch {
    // The protected manifest remains authoritative. A later turn retries link
    // reconciliation; failure here must not roll back or misreport a skill.
  }
}

/** Recreate the native-discovery links from the manifest. Links, not copies,
 * so disable/remove has exactly one source of truth; junctions on Windows
 * because directory symlinks there need privileges junctions do not. */
export function syncSkillLinks(
  botId: string,
  options: { beforeRemove?: (link: string) => void } = {},
): void {
  const root = workspaceDir(botId);
  const previouslyManaged = readManagedLinks(botId);
  // A bot can edit its workspace. Never follow a replaced skills root while
  // deciding which native links are safe to publish. Existing app links must
  // still be revoked, or they start resolving into the replacement.
  if (directoryEntryState(skillsDir(botId)) === "unsafe") {
    removeNativeLinksForUnsafeSkillsRoot(botId, root, previouslyManaged, options.beforeRemove);
    return;
  }
  const manifest = readManifest(botId);
  const enabled = Object.entries(manifest).filter(
    ([name, entry]) => entry.enabled && skillContentMatches(botId, name, entry),
  );
  const desired = new Map(enabled.map(([name, entry]) => [name, skillTarget(root, name, entry)]));
  const managed = new Set<string>();
  for (const dir of NATIVE_SKILL_DIRS) {
    const linkDir = nativeLinkDirectory(root, dir, enabled.length > 0);
    if (!linkDir) continue;
    let existing: string[] = [];
    try {
      existing = readdirSync(linkDir).filter(isSkillName);
    } catch {
      // A missing native directory is created below only when needed.
    }
    // Scanning safely adopts links made by releases before managed-links.json.
    // The registry adds names whose link directory can no longer be listed.
    for (const name of new Set([...existing, ...previouslyManaged])) {
      const link = join(linkDir, name);
      const target = desired.get(name);
      if (target && nativeLinkPointsToSkill(link, target)) {
        managed.add(name);
      } else if (nativeLinkDirectlyTargetsOwnedSkill(link, root, name, previouslyManaged.includes(name))) {
        const result = removeOwnedNativeLink(
          botId,
          link,
          root,
          name,
          previouslyManaged.includes(name),
          options.beforeRemove,
        );
        if (result === "retry") managed.add(name);
      }
    }
    if (!enabled.length) continue;
    for (const [name, entry] of enabled) {
      const link = join(linkDir, name);
      const target = skillTarget(root, name, entry);
      if (nativeLinkPointsToSkill(link, target)) {
        managed.add(name);
        continue;
      }
      try {
        symlinkSync(
          target,
          link,
          process.platform === "win32" ? "junction" : "dir",
        );
        managed.add(name);
      } catch {
        // A user-owned same-name path wins; never replace an unknown path.
      }
    }
  }
  try {
    writeManagedLinks(botId, [...managed]);
  } catch {
    // Native discovery is a repairable projection of the protected manifest.
  }
}

export function skillContentMatches(botId: string, name: string, entry: SkillManifestEntry): boolean {
  try {
    const directory = skillDirectory(botId, name, entry);
    if (!directory) return false;
    const file = join(directory, "SKILL.md");
    if (!lstatSync(file).isFile()) return false;
    return createHash("sha256").update(readFileSync(file)).digest("hex") === entry.sha256;
  } catch {
    return false;
  }
}

export function learnedSkillDirectoryMatches(directory: string, sha256: string): boolean {
  if (directoryEntryState(directory) !== "directory") return false;
  try {
    const entries = readdirSync(directory);
    if (entries.length !== 1 || entries[0] !== "SKILL.md") return false;
    const file = join(directory, "SKILL.md");
    if (!lstatSync(file).isFile()) return false;
    return createHash("sha256").update(readFileSync(file)).digest("hex") === sha256;
  } catch {
    return false;
  }
}
