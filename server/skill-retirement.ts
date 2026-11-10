import { lstatSync, mkdirSync, opendirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SKILL_FILE_MAX_BYTES } from "../shared/skill-md.ts";
import { writeFileAtomic } from "./atomic.ts";
import { partHash, skillReleaseValue } from "./package-parts.ts";
import { snapshotPortableSkill } from "./portable-skill-files.ts";
import { readBoundedSkillFile } from "./bounded-skill-read.ts";
import { localSkillRetirementParentMatches, localSkillRetirementPath, readSkillRetirementReceipt, skillRetirementKey, stableSkillIdentity as stableIdentity } from "./skill-retirement-receipt.ts";
import { SKILL_RECOVERY_CAPACITY_WARNING, skillRecoveryHasCapacity } from "./skill-recovery-capacity.ts";
export { SKILL_RECOVERY_ATTENTION_WARNING, SKILL_RECOVERY_CAPACITY_WARNING } from "./skill-recovery-capacity.ts";

export interface RetiredSkillRoot { identity: string; hash: string; executableFiles?: string[]; recovery?: "capacity" | "attention" }

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

function readSkillText(directory: string): string | null {
  try {
    const bytes = readBoundedSkillFile(join(directory, "SKILL.md"), SKILL_FILE_MAX_BYTES);
    return bytes && new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { return null; }
}

export function skillRootHasExpectedContent(directory: string, expected: string, executableFiles?: readonly string[]): boolean {
  const snapshot = snapshotPortableSkill(directory, () => readSkillText(directory), undefined, undefined, executableFiles ?? null);
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
        const path = join(quarantine, entry.name);
        if (entry.isDirectory() && stableIdentity(skillRootIdentity(path)) === stableIdentity(identity)) return "found";
        if (/^[a-f0-9]{64}\.json$/.test(entry.name)) {
          const receipt = readSkillRetirementReceipt(path);
          if (!receipt) return "unsafe";
          if (receipt.localParent && stableIdentity(receipt.identity) === stableIdentity(identity)) return "found";
        }
      }
    } finally { dir.closeSync(); }
    return "absent";
  } catch { return "unsafe"; }
}

export function skillRetirementCapacity(stateDir: string, incoming: string): { ok: true } | { error: string; reason: "capacity" } {
  const quarantine = join(stateDir, "retired-roots");
  const refusal = { error: `${SKILL_RECOVERY_CAPACITY_WARNING} Recovery folder: ${quarantine}`, reason: "capacity" as const };
  const stateId = skillRootIdentity(stateDir);
  if (!stateId) return refusal;
  if (directoryState(quarantine) === "missing") {
    try { mkdirSync(quarantine, { mode: 0o700 }); } catch { return refusal; }
  }
  const quarantineId = skillRootIdentity(quarantine);
  if (!quarantineId || !skillRecoveryHasCapacity(quarantine, incoming) ||
      stableIdentity(skillRootIdentity(stateDir)) !== stableIdentity(stateId) ||
      stableIdentity(skillRootIdentity(quarantine)) !== stableIdentity(quarantineId)) return refusal;
  return { ok: true };
}

/** Keep the original inode: an already-open writer can still change it after any content check. */
export function retireUnchangedSkillRoot(
  directory: string, retired: RetiredSkillRoot, stateDir: string,
  options: { beforeMove?: () => void; afterVerify?: (moved: string) => void } = {},
): { retired: true } | { error: string; reason?: "capacity" } {
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
  const record = { directory: resolve(directory), identity: retired.identity, hash: retired.hash };
  const key = skillRetirementKey(record), marker = join(quarantine, `${key}.json`);
  const prior = readSkillRetirementReceipt(marker);
  let localParent = prior?.localParent;
  let moved = localParent ? localSkillRetirementPath(record) : join(quarantine, key);
  const parentId = parentState === "directory" ? skillRootIdentity(parent) : null;
  const localSafe = () => !localParent || localSkillRetirementParentMatches({ ...record, localParent });
  if (!localSafe()) return { error: "the local recovery parent changed or could not be checked safely" };
  const legacy = JSON.stringify(record);
  const receiptFor = (state: "pending" | "retained") => JSON.stringify({ ...record, ...(localParent ? { localParent } : {}), state });
  let pending = receiptFor("pending"), retained = receiptFor("retained");
  const recoveryError = { error: `the previous skill folder still needs recovery in ${quarantine}; this attempt deleted no files` };
  const movedState = directoryState(moved);
  if (movedState === "unsafe") return recoveryError;
  const readReceipt = () => readBoundedSkillFile(marker, 16_384)?.toString("utf8");
  if (movedState === "missing" && originalState === "missing") {
    if (localParent) return recoveryError;
    const old = findEarlierQuarantine(quarantine, retired.identity);
    if (old !== "absent") return recoveryError;
    // Old receipts may be left by the prior cleanup after it deleted the folder.
    if (directoryState(marker) !== "missing" && ![legacy, retained].includes(readReceipt() ?? "")) return recoveryError;
    return { retired: true };
  }
  let justMoved = false;
  if (movedState === "missing") {
    if (!parentId || skillRootIdentity(directory) !== retired.identity || !skillRootHasExpectedContent(directory, retired.hash, retired.executableFiles)) return changed;
    if (directoryState(marker) !== "missing" && ![legacy, pending].includes(readReceipt() ?? "")) return recoveryError;
    const capacity = skillRetirementCapacity(stateDir, directory);
    if ("error" in capacity) return capacity;
    try {
      // Persist the original identity before the move so a crash leaves an attributable recovery path.
      writeFileAtomic(marker, pending, { mode: 0o600 });
      options.beforeMove?.();
      if (skillRootIdentity(directory) !== retired.identity || stableIdentity(skillRootIdentity(parent)) !== stableIdentity(parentId) ||
        stableIdentity(skillRootIdentity(stateDir)) !== stableIdentity(stateId) || stableIdentity(skillRootIdentity(quarantine)) !== stableIdentity(quarantineId) ||
        !localSafe() || directoryState(moved) !== "missing") return recoveryError;
      try { renameSync(directory, moved); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV" || localParent || skillRootIdentity(directory) !== retired.identity ||
          directoryState(moved) !== "missing" || !skillRootHasExpectedContent(directory, retired.hash, retired.executableFiles)) throw error;
        localParent = parentId!;
        moved = localSkillRetirementPath(record);
        pending = receiptFor("pending"); retained = receiptFor("retained");
        if (!localSafe() || directoryState(moved) !== "missing") return recoveryError;
        writeFileAtomic(marker, pending, { mode: 0o600 });
        renameSync(directory, moved);
      }
      justMoved = true;
    }
    catch { return { error: "the previous skill folder could not be moved safely" }; }
  } else if (originalState !== "missing") {
    // A replacement at the original name makes the interrupted move ambiguous.
    return recoveryError;
  }
  const restore = () => {
    try {
      if (stableIdentity(skillRootIdentity(parent)) === stableIdentity(parentId) && directoryState(directory) === "missing") renameSync(moved, directory);
    } catch {}
  };
  const receipt = readReceipt();
  if (!localSafe() || stableIdentity(skillRootIdentity(moved)) !== stableIdentity(retired.identity) ||
    stableIdentity(skillRootIdentity(stateDir)) !== stableIdentity(stateId) ||
    stableIdentity(skillRootIdentity(quarantine)) !== stableIdentity(quarantineId) ||
    ![legacy, pending, retained].includes(receipt ?? "")) {
    if (justMoved) restore();
    return recoveryError;
  }
  if (receipt === retained) return { retired: true };
  if (!skillRootHasExpectedContent(moved, retired.hash, retired.executableFiles)) {
    if (justMoved) restore();
    return recoveryError;
  }
  try {
    options.afterVerify?.(moved);
    if (!localSafe() || stableIdentity(skillRootIdentity(moved)) !== stableIdentity(retired.identity) ||
      stableIdentity(skillRootIdentity(stateDir)) !== stableIdentity(stateId) || stableIdentity(skillRootIdentity(quarantine)) !== stableIdentity(quarantineId) ||
      readReceipt() !== receipt) return recoveryError;
    writeFileAtomic(marker, retained, { mode: 0o600 });
    if (readReceipt() !== retained) return recoveryError;
    return { retired: true };
  } catch { return recoveryError; }
}
