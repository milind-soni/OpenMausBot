import { createHash } from "node:crypto";
import { lstatSync, opendirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { localSkillRetirementParentMatches, localSkillRetirementPath, readSkillRetirementReceipt, stableSkillIdentity } from "./skill-retirement-receipt.ts";

export const SKILL_RECOVERY_MAX_ROOTS = 32;
export const SKILL_RECOVERY_MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 8_192;
const MAX_DEPTH = 16;

export const SKILL_RECOVERY_CAPACITY_WARNING = "Skill recovery storage is full or cannot be checked safely. Stop processes using old skills, move retained recovery folders and their receipts to a private backup, then retry. See the organization library recovery guide.";
export const SKILL_RECOVERY_ATTENTION_WARNING = "A previous skill folder needs recovery. Stop processes using old skills and follow the organization library recovery guide before retrying.";

export function skillUpdateGuardPath(state: string, name: string): string {
  return join(state, "org-skill-staging", `pending-${createHash("sha256").update(name).digest("hex")}.json`);
}

/** A leftover guard is a durable fence, including when its contents cannot be read safely. */
export function skillUpdateNeedsRecovery(state: string, name: string): boolean {
  try {
    const staging = lstatSync(join(state, "org-skill-staging"));
    if (!staging.isDirectory() || staging.isSymbolicLink()) return true;
    try { lstatSync(skillUpdateGuardPath(state, name)); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

/** Never follow links while accounting for retained data. Uncertainty refuses another move. */
export function skillRecoveryHasCapacity(quarantine: string, incoming: string): boolean {
  let entries = 0, bytes = 0, roots = 0;
  const unchanged = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mode === b.mode && a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  const walk = (path: string, depth: number): boolean => {
    if (depth > MAX_DEPTH || ++entries > MAX_ENTRIES) return false;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return false;
    if (stat.isFile()) {
      if (stat.nlink > 1 || !Number.isSafeInteger(stat.size) || stat.size < 0) return false;
      bytes += stat.size;
      return bytes <= SKILL_RECOVERY_MAX_BYTES && unchanged(stat, lstatSync(path));
    }
    if (!stat.isDirectory()) return false;
    const handle = opendirSync(path);
    try {
      for (let item = handle.readSync(); item; item = handle.readSync()) {
        if (!walk(join(path, item.name), depth + 1)) return false;
      }
    } finally { handle.closeSync(); }
    return unchanged(stat, lstatSync(path));
  };
  try {
    const stat = lstatSync(quarantine);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const handle = opendirSync(quarantine);
    try {
      for (let item = handle.readSync(); item; item = handle.readSync()) {
        const path = join(quarantine, item.name), info = lstatSync(path);
        if (info.isDirectory() && ++roots >= SKILL_RECOVERY_MAX_ROOTS) return false;
        if (!walk(path, 0)) return false;
        if (/^[a-f0-9]{64}\.json$/.test(item.name)) {
          const receipt = readSkillRetirementReceipt(path);
          if (!receipt) return false;
          if (receipt.localParent) {
            if (!localSkillRetirementParentMatches(receipt)) return false;
            let retained = localSkillRetirementPath(receipt);
            try { lstatSync(retained); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT" || receipt.state !== "pending") return false;
              retained = receipt.directory;
            }
            const held = lstatSync(retained);
            if (!held.isDirectory() || held.isSymbolicLink() || stableSkillIdentity(`${held.dev}:${held.ino}:${held.birthtimeMs}:${held.ctimeMs}`) !== stableSkillIdentity(receipt.identity)) return false;
            if (retained !== incoming && (++roots >= SKILL_RECOVERY_MAX_ROOTS || !walk(retained, 0))) return false;
            if (!localSkillRetirementParentMatches(receipt) || !unchanged(held, lstatSync(retained))) return false;
          }
        }
      }
    } finally { handle.closeSync(); }
    return unchanged(stat, lstatSync(quarantine)) && walk(incoming, 0);
  } catch { return false; }
}
