import { createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";

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
  const walk = (path: string, depth: number): boolean => {
    if (depth > MAX_DEPTH || ++entries > MAX_ENTRIES) return false;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return false;
    if (stat.isFile()) {
      if (stat.nlink > 1 || !Number.isSafeInteger(stat.size) || stat.size < 0) return false;
      bytes += stat.size;
      return bytes <= SKILL_RECOVERY_MAX_BYTES;
    }
    if (!stat.isDirectory()) return false;
    const handle = opendirSync(path);
    try {
      for (let item = handle.readSync(); item; item = handle.readSync()) {
        if (!walk(join(path, item.name), depth + 1)) return false;
      }
    } finally { handle.closeSync(); }
    return true;
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
      }
    } finally { handle.closeSync(); }
    return walk(incoming, 0);
  } catch { return false; }
}
