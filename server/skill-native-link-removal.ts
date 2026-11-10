import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { entryExistsWithoutFollowing } from "./skill-storage.ts";
import { skillRootIdentity } from "./skill-retirement.ts";
import { stableSkillIdentity } from "./skill-retirement-receipt.ts";

export function nativeLinkDirectlyTargetsOwnedSkill(
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
/** renameSync is the identity boundary: a workspace process can replace the name, not which entry was moved. */
export function removeOwnedNativeLink(
  state: string,
  link: string,
  root: string,
  name: string,
  revisionWasManaged: boolean,
  beforeRemove?: (link: string) => void,
): NativeLinkRemoval {
  const quarantineDir = join(state, "link-removal");
  try {
    mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  } catch {
    return "retry";
  }
  if (!skillRootIdentity(state) || !skillRootIdentity(quarantineDir)) return "retry";
  const quarantined = join(quarantineDir, randomUUID());
  beforeRemove?.(link);
  try {
    renameSync(link, quarantined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      return retainLocalNativeLink(state, quarantineDir, link, root, name, revisionWasManaged);
    }
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

function retainLocalNativeLink(state: string, quarantine: string, link: string, root: string, name: string, revisionWasManaged: boolean): NativeLinkRemoval {
  try {
    const parent = dirname(link), parentId = stableSkillIdentity(skillRootIdentity(parent));
    const stateId = stableSkillIdentity(skillRootIdentity(state)), quarantineId = stableSkillIdentity(skillRootIdentity(quarantine));
    if (!parentId || !stateId || !quarantineId) return "retry";
    const local = mkdtempSync(join(parent, ".omb-link-removal-")), localId = stableSkillIdentity(skillRootIdentity(local));
    const moved = join(local, "entry"), marker = join(quarantine, `${randomUUID()}.json`);
    const record = { link, moved, parentIdentity: parentId, localIdentity: localId };
    writeFileAtomic(marker, JSON.stringify({ ...record, state: "pending" }), { mode: 0o600 });
    const unchanged = () => parentId === stableSkillIdentity(skillRootIdentity(parent)) && localId === stableSkillIdentity(skillRootIdentity(local)) &&
      stateId === stableSkillIdentity(skillRootIdentity(state)) && quarantineId === stableSkillIdentity(skillRootIdentity(quarantine));
    if (!localId || !unchanged() || entryExistsWithoutFollowing(moved)) return "retry";
    renameSync(link, moved);
    if (!unchanged()) return "retry";
    // Local recovery is workspace-writable: keep the moved entry rather than unlinking a possible replacement.
    writeFileAtomic(marker, JSON.stringify({ ...record, state: "retained" }), { mode: 0o600 });
    if (!unchanged()) return "retry";
    if (nativeLinkDirectlyTargetsOwnedSkill(moved, root, name, revisionWasManaged, parent)) return "removed";
    if (!entryExistsWithoutFollowing(link)) renameSync(moved, link);
    return "preserved";
  } catch { return "retry"; }
}
