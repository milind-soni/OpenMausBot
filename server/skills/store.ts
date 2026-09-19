// The reviewed skill store API — listing, reading, enabling, removing,
// and the revision retirement that keeps reviewed workspace storage
// bounded.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import { LEARN_SOURCE_PREFIX } from "../skill-learn.ts";
import { isSkillName, parseSkillMd, SKILL_FILE_MAX_BYTES } from "./text.ts";
import {
  directoryEntryState,
  existingSkillDirectory,
  existingSkillsRoot,
  learnedSkillDirectoryMatches,
  readManifest,
  skillContentMatches,
  skillDirectory,
  skillsDir,
  syncSkillLinks,
  writeManifest,
} from "./manifest.ts";
import type { SkillManifestEntry } from "./manifest.ts";

export interface SkillListing {
  name: string;
  description: string;
  enabled: boolean;
  /** Only review-created learned skills have a revision token strong enough
   * to support an in-place, review-gated update. */
  editable: boolean;
  source: string;
  sha256: string;
  importedAt: string;
  license?: string;
  compatibility?: string;
  warnings: string[];
  skippedFiles: string[];
}

export function skillListing(botId: string, name: string, entry: SkillManifestEntry): SkillListing {
  const { appliedStageId, storageRevision: _storageRevision, ...visible } = entry;
  const intact = skillContentMatches(botId, name, entry);
  return {
    name,
    ...visible,
    enabled: entry.enabled && intact,
    editable: entry.source.startsWith(LEARN_SOURCE_PREFIX) && Boolean(appliedStageId),
    warnings: intact
      ? visible.warnings
      : [...visible.warnings, "stored SKILL.md changed after review — enablement is blocked"],
  };
}

export function listSkills(botId: string): SkillListing[] {
  const manifest = readManifest(botId);
  return Object.entries(manifest)
    .map(([name, entry]) => skillListing(botId, name, entry))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkillFile(botId: string, name: string): string | null {
  if (!isSkillName(name)) return null;
  const entry = readManifest(botId)[name];
  if (!entry) return null;
  const directory = skillDirectory(botId, name, entry);
  if (!directory) return null;
  let descriptor: number | null = null;
  try {
    const path = join(directory, "SKILL.md");
    const before = lstatSync(path);
    if (!before.isFile() || before.size > SKILL_FILE_MAX_BYTES) return null;
    descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > SKILL_FILE_MAX_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) return null;
    const text = readFileSync(descriptor, "utf8");
    return createHash("sha256").update(text).digest("hex") === entry.sha256 ? text : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

export function setSkillEnabled(botId: string, name: string, enabled: boolean): SkillListing | { error: string } {
  if (!isSkillName(name)) return { error: "invalid skill name" };
  const manifest = readManifest(botId);
  const entry = manifest[name];
  if (!entry) return { error: `no imported skill named "${name}"` };
  if (enabled && !skillContentMatches(botId, name, entry)) {
    return { error: "stored SKILL.md changed after review — remove and import or learn it again" };
  }
  entry.enabled = enabled;
  writeManifest(botId, manifest);
  syncSkillLinks(botId);
  return skillListing(botId, name, entry);
}

export function removeReviewedRevision(botId: string, revision: string, sha256: string): void {
  const root = existingSkillsRoot(botId);
  if (!root) return;
  const revisions = join(root, ".revisions");
  if (directoryEntryState(revisions) !== "directory") return;
  const directory = join(revisions, revision);
  if (!learnedSkillDirectoryMatches(directory, sha256)) return;
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // This storage is no longer selected. Explicit skill removal also scans
    // the revision namespace, so a transient cleanup failure is recoverable.
  }
}

export function retireReviewedSkillStorage(botId: string, name: string, entry: SkillManifestEntry): void {
  if (entry.storageRevision) {
    removeReviewedRevision(botId, entry.storageRevision, entry.sha256);
    return;
  }
  const directory = existingSkillDirectory(botId, name);
  if (!directory || !learnedSkillDirectoryMatches(directory, entry.sha256)) return;
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // The manifest no longer selects these bytes; retry is unnecessary for
    // correctness, and explicit removal cleans matching leftovers.
  }
}

function removeReviewedRevisionsNamed(botId: string, name: string): void {
  const root = existingSkillsRoot(botId);
  if (!root) return;
  const revisions = join(root, ".revisions");
  if (directoryEntryState(revisions) !== "directory") return;
  let candidates: string[];
  try {
    candidates = readdirSync(revisions).filter((entry) => /^[a-f0-9]{64}$/.test(entry));
  } catch {
    return;
  }
  for (const revision of candidates) {
    const directory = join(revisions, revision);
    if (directoryEntryState(directory) !== "directory") continue;
    try {
      const file = join(directory, "SKILL.md");
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > SKILL_FILE_MAX_BYTES) continue;
      const parsed = parseSkillMd(readFileSync(file, "utf8"));
      if ("error" in parsed || parsed.name !== name) continue;
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A changed or busy revision stays inert and can be removed manually.
    }
  }
}

export function removeSkill(botId: string, name: string): { removed: true } | { error: string } {
  if (!isSkillName(name)) return { error: "invalid skill name" };
  const manifest = readManifest(botId);
  const entry = manifest[name];
  if (!entry) return { error: `no imported skill named "${name}"` };
  const root = skillsDir(botId);
  if (directoryEntryState(root) === "unsafe") {
    return { error: "the workspace skills path is a symlink or file; refusing to remove through it" };
  }
  const target = entry.storageRevision ? null : join(root, name);
  const targetState = target ? directoryEntryState(target) : "missing";
  delete manifest[name];
  writeManifest(botId, manifest);
  // Remove our native links while their target still exists, so ownership
  // can be proven without ever deleting a user-replaced path.
  syncSkillLinks(botId);
  if (entry.storageRevision) {
    // Re-check both the revisions parent and the reviewed content immediately
    // before deletion. Never follow a workspace-replaced `.revisions` link.
    removeReviewedRevision(botId, entry.storageRevision, entry.sha256);
  } else if (target && targetState === "directory") {
    rmSync(target, { recursive: true, force: true });
  }
  removeReviewedRevisionsNamed(botId, name);
  return { removed: true };
}
