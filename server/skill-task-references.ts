import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { lstat, opendir, readlink, realpath } from "node:fs/promises";
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

async function checkedStatAsync(path: string): Promise<Stats | null | undefined> {
  try { return await lstat(path); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined; }
}

async function inspectTaskAsync(task: string, name: string, targets: readonly string[], physicalTargets: readonly string[], references: boolean[]): Promise<boolean> {
  const taskBefore = await checkedStatAsync(task);
  if (!taskBefore?.isDirectory() || taskBefore.isSymbolicLink()) return false;
  try {
    for (const family of familyDirs) {
      const familyPath = join(task, family), familyBefore = await checkedStatAsync(familyPath);
      if (familyBefore === null) continue;
      if (!familyBefore?.isDirectory() || familyBefore.isSymbolicLink()) return false;
      const linkDir = join(familyPath, "skills"), linkDirBefore = await checkedStatAsync(linkDir);
      if (linkDirBefore === null) {
        const familyAfter = await checkedStatAsync(familyPath);
        if (!familyAfter || !unchanged(familyBefore, familyAfter)) return false;
        continue;
      }
      if (!linkDirBefore?.isDirectory() || linkDirBefore.isSymbolicLink()) return false;
      const link = join(linkDir, name), linkBefore = await checkedStatAsync(link);
      if (linkBefore === undefined) return false;
      if (linkBefore !== null) {
        if (!linkBefore.isSymbolicLink()) return false;
        const raw = resolve(dirname(link), (await readlink(link)).replace(/^\\\\\?\\/, ""));
        let actual: string;
        try { actual = await realpath(link); } catch { return false; }
        targets.forEach((target, index) => { if (pointsInside(target, raw) || pointsInside(physicalTargets[index]!, actual)) references[index] = true; });
        const linkAfter = await checkedStatAsync(link);
        if (!linkAfter || !unchanged(linkBefore, linkAfter)) return false;
      }
      const linkDirAfter = await checkedStatAsync(linkDir), familyAfter = await checkedStatAsync(familyPath);
      if (!linkDirAfter || !familyAfter || !unchanged(linkDirBefore, linkDirAfter) || !unchanged(familyBefore, familyAfter)) return false;
    }
    const taskAfter = await checkedStatAsync(task);
    return Boolean(taskAfter && unchanged(taskBefore, taskAfter));
  } catch { return false; }
}

/** Reads only, once for all revisions: uncertainty keeps every old revision. */
export async function taskSkillsMayReferTo(botId: string, name: string, targets: readonly string[]): Promise<boolean[]> {
  const keepAll = () => targets.map(() => true);
  const references = targets.map(() => false);
  if (!targets.length) return references;
  if (!safeId(botId) || !isSkillName(name) || targets.length > 32) return keepAll();
  const physicalTargets = await Promise.all(targets.map(async (target) => { try { return await realpath(target); } catch { return target; } }));
  const parent = await checkedStatAsync(TASK_WORKSPACES_DIR);
  if (parent === null) return await checkedStatAsync(TASK_WORKSPACES_DIR) === null ? references : keepAll();
  if (!parent?.isDirectory() || parent.isSymbolicLink()) return keepAll();
  const botRoot = join(TASK_WORKSPACES_DIR, botId), before = await checkedStatAsync(botRoot);
  if (before === null) {
    const after = await checkedStatAsync(TASK_WORKSPACES_DIR);
    return after && unchanged(parent, after) ? references : keepAll();
  }
  if (!before?.isDirectory() || before.isSymbolicLink()) return keepAll();
  try {
    const dir = await opendir(botRoot);
    let count = 0;
    try {
      for (let entry = await dir.read(); entry; entry = await dir.read()) {
        if (++count > MAX_TASKS) return keepAll();
        if (!safeId(entry.name)) continue;
        if (!await inspectTaskAsync(join(botRoot, entry.name), name, targets, physicalTargets, references)) return keepAll();
      }
    } finally { await dir.close(); }
    const after = await checkedStatAsync(botRoot), parentAfter = await checkedStatAsync(TASK_WORKSPACES_DIR);
    return !after || !parentAfter || !unchanged(before, after) || !unchanged(parent, parentAfter) ? keepAll() : references;
  } catch { return keepAll(); }
}
