import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, opendirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SKILL_FILE_MAX_BYTES } from "../shared/skill-md.ts";
import { writeFileAtomic } from "./atomic.ts";
import { partHash, skillReleaseValue } from "./package-parts.ts";
import { snapshotPortableSkill } from "./portable-skill-files.ts";
import { readBoundedSkillFile } from "./bounded-skill-read.ts";

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
  try {
    const bytes = readBoundedSkillFile(join(directory, "SKILL.md"), SKILL_FILE_MAX_BYTES);
    return bytes && new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { return null; }
}

export function skillRootHasExpectedContent(directory: string, expected: string): boolean {
  const snapshot = snapshotPortableSkill(directory, () => readSkillText(directory));
  return Boolean(snapshot && !snapshot.skipped.length && partHash(skillReleaseValue(snapshot)) === expected);
}

/** An existing quarantine with this identity prevents a false success. */
function findEarlierQuarantine(quarantine: string, identity: string): "found" | "absent" | "unsafe" {
  try {
    const dir = opendirSync(quarantine);
    let count = 0;
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++count > 2_048) return "unsafe";
        if (entry.isDirectory() && stableIdentity(skillRootIdentity(join(quarantine, entry.name))) === stableIdentity(identity)) return "found";
      }
    } finally { dir.closeSync(); }
    return "absent";
  } catch { return "unsafe"; }
}

/** Move into protected state before deleting, and recheck what actually moved; never delete a swapped path. */
export function retireUnchangedSkillRoot(
  directory: string, retired: RetiredSkillRoot, stateDir: string,
  options: { beforeMove?: () => void; remove?: typeof rmSync } = {},
): { retired: true } | { error: string } {
  const changed = { error: "the previous skill folder changed; move it before removing this skill" };
  const parent = dirname(directory), parentState = directoryState(parent);
  if (parentState === "unsafe") return { error: "the previous skill folder could not be checked safely" };
  if (directoryState(stateDir) !== "directory") return { error: "the protected skill state could not be checked safely" };
  const quarantine = join(stateDir, "retired-roots");
  const originalState = parentState === "missing" ? "missing" : directoryState(directory);
  if (directoryState(quarantine) === "missing") {
    if (originalState === "missing") return { retired: true };
    try { mkdirSync(quarantine, { mode: 0o700 }); } catch { return { error: "the protected recovery folder could not be created" }; }
  }
  const stateId = skillRootIdentity(stateDir), quarantineId = skillRootIdentity(quarantine);
  if (!stateId || !quarantineId) return { error: "the protected recovery folder could not be checked safely" };
  const key = createHash("sha256").update(JSON.stringify([resolve(directory), retired.identity, retired.hash])).digest("hex");
  const moved = join(quarantine, key), marker = `${moved}.json`;
  const record = JSON.stringify({ directory: resolve(directory), identity: retired.identity, hash: retired.hash });
  const recoveryError = { error: `the previous skill folder still needs cleanup in ${quarantine}` };
  const movedState = directoryState(moved);
  if (movedState === "unsafe") return recoveryError;
  const readReceipt = () => readBoundedSkillFile(marker, 16_384)?.toString("utf8");
  if (movedState === "missing" && originalState === "missing") {
    const old = findEarlierQuarantine(quarantine, retired.identity);
    if (old !== "absent") return recoveryError;
    // A crash after deleting the folder but before deleting its receipt is harmless.
    if (directoryState(marker) !== "missing" && readReceipt() !== record) return recoveryError;
    try { rmSync(marker, { force: true }); } catch { return recoveryError; }
    return { retired: true };
  }
  const parentId = parentState === "directory" ? skillRootIdentity(parent) : null;
  let justMoved = false;
  if (movedState === "missing") {
    if (!parentId || skillRootIdentity(directory) !== retired.identity || !skillRootHasExpectedContent(directory, retired.hash)) return changed;
    if (directoryState(marker) !== "missing" && readReceipt() !== record) return recoveryError;
    try {
      // Persist the original identity before the move so a crash leaves an attributable recovery path.
      writeFileAtomic(marker, record, { mode: 0o600 });
      options.beforeMove?.(); renameSync(directory, moved); justMoved = true;
    }
    catch { return { error: "the previous skill folder could not be moved safely" }; }
  } else if (originalState !== "missing") {
    // Do not delete a quarantine while a replacement occupies its original name.
    return recoveryError;
  }
  const restore = () => {
    try {
      if (stableIdentity(skillRootIdentity(parent)) === stableIdentity(parentId) && directoryState(directory) === "missing") renameSync(moved, directory);
    } catch {}
  };
  if (stableIdentity(skillRootIdentity(moved)) !== stableIdentity(retired.identity) ||
    stableIdentity(skillRootIdentity(stateDir)) !== stableIdentity(stateId) ||
    stableIdentity(skillRootIdentity(quarantine)) !== stableIdentity(quarantineId) ||
    readReceipt() !== record || !skillRootHasExpectedContent(moved, retired.hash)) {
    // A partial deletion cannot be re-verified; retain it for explicit recovery, never delete blindly.
    if (justMoved) restore();
    return recoveryError;
  }
  try {
    (options.remove ?? rmSync)(moved, { recursive: true, force: true });
    rmSync(marker, { force: true });
    return { retired: true };
  } catch { return recoveryError; }
}
