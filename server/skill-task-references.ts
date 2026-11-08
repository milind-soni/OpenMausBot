import { lstatSync, opendirSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isSkillName } from "../shared/skill-md.ts";
import { TASK_WORKSPACES_DIR } from "./workspace.ts";

const MAX_TASKS = 4_096;
const familyDirs = [".claude", ".agents", ".grok"];
const safeId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
const comparable = (path: string) => {
  const value = resolve(path).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? value.toLowerCase() : value;
};
const unchanged = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** null means absent; undefined means the path could not be checked safely. */
function checkedStat(path: string): Stats | null | undefined {
  try { return lstatSync(path); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined; }
}

function pointsInside(target: string, candidate: string): boolean {
  const rest = relative(comparable(target), comparable(candidate));
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
}

/** Checks only one workspace; uncertainty preserves the old links. */
function inspectTask(task: string, name: string, targets: readonly string[], physicalTargets: readonly string[], references: boolean[]): boolean {
  const taskBefore = checkedStat(task);
  if (!taskBefore?.isDirectory() || taskBefore.isSymbolicLink()) return false;
  try {
    for (const family of familyDirs) {
      const familyPath = join(task, family), familyBefore = checkedStat(familyPath);
      if (familyBefore === null) continue;
      if (!familyBefore?.isDirectory() || familyBefore.isSymbolicLink()) return false;
      const linkDir = join(familyPath, "skills"), linkDirBefore = checkedStat(linkDir);
      if (linkDirBefore === null) {
        const familyAfter = checkedStat(familyPath);
        if (!familyAfter || !unchanged(familyBefore, familyAfter)) return false;
        continue;
      }
      if (!linkDirBefore?.isDirectory() || linkDirBefore.isSymbolicLink()) return false;
      const link = join(linkDir, name), linkBefore = checkedStat(link);
      if (linkBefore === undefined) return false;
      if (linkBefore !== null) {
        if (!linkBefore.isSymbolicLink()) return false;
        const raw = resolve(dirname(link), readlinkSync(link).replace(/^\\\\\?\\/, ""));
        let actual: string;
        try { actual = realpathSync(link); } catch { return false; }
        targets.forEach((target, index) => { if (pointsInside(target, raw) || pointsInside(physicalTargets[index]!, actual)) references[index] = true; });
        const linkAfter = checkedStat(link);
        if (!linkAfter || !unchanged(linkBefore, linkAfter)) return false;
      }
      const linkDirAfter = checkedStat(linkDir), familyAfter = checkedStat(familyPath);
      if (!linkDirAfter || !familyAfter || !unchanged(linkDirBefore, linkDirAfter) || !unchanged(familyBefore, familyAfter)) return false;
    }
    const taskAfter = checkedStat(task);
    return Boolean(taskAfter && unchanged(taskBefore, taskAfter));
  } catch { return false; }
}

/** A turn checks its own task only, never another guest's workspace. */
export function taskSkillMayReferTo(botId: string, threadId: string, name: string, targets: readonly string[]): boolean {
  if (!targets.length) return false;
  if (!safeId(botId) || !safeId(threadId) || !isSkillName(name) || targets.length > 33) return true;
  const parent = checkedStat(TASK_WORKSPACES_DIR), botRoot = join(TASK_WORKSPACES_DIR, botId), botBefore = checkedStat(botRoot);
  if (!parent?.isDirectory() || parent.isSymbolicLink() || !botBefore?.isDirectory() || botBefore.isSymbolicLink()) return true;
  const physical = targets.map((target) => { try { return realpathSync(target); } catch { return target; } });
  const references = targets.map(() => false);
  if (!inspectTask(join(botRoot, threadId), name, targets, physical, references)) return true;
  const parentAfter = checkedStat(TASK_WORKSPACES_DIR), botAfter = checkedStat(botRoot);
  return !parentAfter || !botAfter || !unchanged(parent, parentAfter) || !unchanged(botBefore, botAfter) || references.some(Boolean);
}

/** Reads only, once for all revisions: uncertainty keeps every old revision. */
export function taskSkillsMayReferTo(botId: string, name: string, targets: readonly string[]): boolean[] {
  const keepAll = () => targets.map(() => true);
  const references = targets.map(() => false);
  if (!targets.length) return references;
  if (!safeId(botId) || !isSkillName(name) || targets.length > 32) return keepAll();
  const physicalTargets = targets.map((target) => { try { return realpathSync(target); } catch { return target; } });
  const parent = checkedStat(TASK_WORKSPACES_DIR);
  if (parent === null) return checkedStat(TASK_WORKSPACES_DIR) === null ? references : keepAll();
  if (!parent?.isDirectory() || parent.isSymbolicLink()) return keepAll();
  const botRoot = join(TASK_WORKSPACES_DIR, botId), before = checkedStat(botRoot);
  if (before === null) {
    const after = checkedStat(TASK_WORKSPACES_DIR);
    return after && unchanged(parent, after) ? references : keepAll();
  }
  if (!before?.isDirectory() || before.isSymbolicLink()) return keepAll();
  try {
    const dir = opendirSync(botRoot);
    let count = 0;
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++count > MAX_TASKS) return keepAll();
        if (!safeId(entry.name)) continue;
        if (!inspectTask(join(botRoot, entry.name), name, targets, physicalTargets, references)) return keepAll();
      }
    } finally { dir.closeSync(); }
    const after = checkedStat(botRoot), parentAfter = checkedStat(TASK_WORKSPACES_DIR);
    return !after || !parentAfter || !unchanged(before, after) || !unchanged(parent, parentAfter) ? keepAll() : references;
  } catch { return keepAll(); }
}
