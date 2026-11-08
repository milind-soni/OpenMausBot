import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { SKILL_FILE_MAX_BYTES } from "../shared/skill-md.ts";
import { partHash, skillReleaseValue } from "./package-parts.ts";
import { snapshotPortableSkill } from "./portable-skill-files.ts";

export interface RetiredSkillRoot { identity: string; hash: string }

function directoryState(directory: string): "directory" | "missing" | "unsafe" {
  try { const stat = lstatSync(directory); return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "unsafe"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe"; }
}

/** A replaced directory must not be mistaken for the one the app used to own. */
export function skillRootIdentity(directory: string): string | null {
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() ? `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}` : null;
  } catch { return null; }
}
const stableIdentity = (identity: string | null) => identity?.slice(0, identity.lastIndexOf(":")) ?? null;

function readSkillText(directory: string): string | null {
  let fd: number | null = null;
  try {
    const file = join(directory, "SKILL.md"), before = lstatSync(file);
    if (!before.isFile() || before.nlink > 1 || before.size > SKILL_FILE_MAX_BYTES) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null;
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || bytes.length !== before.size) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

function hasExpectedContent(directory: string, expected: string): boolean {
  const snapshot = snapshotPortableSkill(directory, () => readSkillText(directory));
  return Boolean(snapshot && !snapshot.skipped.length && partHash(skillReleaseValue(snapshot)) === expected);
}

/** Move into protected state before deleting, and recheck what actually moved; never delete a swapped path. */
export function retireUnchangedSkillRoot(
  directory: string, retired: RetiredSkillRoot, stateDir: string, options: { beforeMove?: () => void } = {},
): { retired: true } | { error: string } {
  const changed = { error: "the previous skill folder changed; move it before removing this skill" };
  const parent = dirname(directory), parentState = directoryState(parent);
  if (parentState === "missing") return { retired: true };
  if (parentState !== "directory") return { error: "the previous skill folder could not be checked safely" };
  if (directoryState(directory) === "missing") return { retired: true };
  const parentId = skillRootIdentity(parent);
  if (!parentId || skillRootIdentity(directory) !== retired.identity || !hasExpectedContent(directory, retired.hash)) return changed;
  if (directoryState(stateDir) !== "directory") return { error: "the protected skill state could not be checked safely" };
  const quarantine = join(stateDir, "retired-roots");
  if (directoryState(quarantine) === "missing") {
    try { mkdirSync(quarantine, { mode: 0o700 }); } catch { return { error: "the protected recovery folder could not be created" }; }
  }
  const stateId = skillRootIdentity(stateDir), quarantineId = skillRootIdentity(quarantine);
  if (!stateId || !quarantineId) return { error: "the protected recovery folder could not be checked safely" };
  const moved = join(quarantine, randomUUID());
  try { options.beforeMove?.(); renameSync(directory, moved); }
  catch { return { error: "the previous skill folder could not be moved safely" }; }
  const restore = () => {
    try {
      if (stableIdentity(skillRootIdentity(parent)) === stableIdentity(parentId) && directoryState(directory) === "missing") renameSync(moved, directory);
    } catch {}
  };
  if (stableIdentity(skillRootIdentity(moved)) !== stableIdentity(retired.identity) ||
    stableIdentity(skillRootIdentity(stateDir)) !== stableIdentity(stateId) ||
    stableIdentity(skillRootIdentity(quarantine)) !== stableIdentity(quarantineId) || !hasExpectedContent(moved, retired.hash)) {
    restore(); return changed;
  }
  try { rmSync(moved, { recursive: true, force: true }); return { retired: true }; }
  catch { return { error: "the previous skill folder could not be removed safely" }; }
}
