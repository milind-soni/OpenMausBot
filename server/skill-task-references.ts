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
        const task = join(botRoot, entry.name), taskBefore = checkedStat(task);
        if (!taskBefore?.isDirectory() || taskBefore.isSymbolicLink()) return keepAll();
        for (const family of familyDirs) {
          const familyPath = join(task, family), familyBefore = checkedStat(familyPath);
          if (familyBefore === null) continue;
          if (!familyBefore?.isDirectory() || familyBefore.isSymbolicLink()) return keepAll();
          const linkDir = join(familyPath, "skills"), linkDirBefore = checkedStat(linkDir);
          if (linkDirBefore === null) {
            const familyAfter = checkedStat(familyPath);
            if (!familyAfter || !unchanged(familyBefore, familyAfter)) return keepAll();
            continue;
          }
          if (!linkDirBefore?.isDirectory() || linkDirBefore.isSymbolicLink()) return keepAll();
          const link = join(linkDir, name), linkBefore = checkedStat(link);
          if (linkBefore === undefined) return keepAll();
          if (linkBefore !== null) {
            if (!linkBefore.isSymbolicLink()) return keepAll();
            const raw = resolve(dirname(link), readlinkSync(link).replace(/^\\\\\?\\/, ""));
            let actual: string;
            try { actual = realpathSync(link); } catch { return keepAll(); }
            targets.forEach((target, index) => { if (pointsInside(target, raw) || pointsInside(physicalTargets[index]!, actual)) references[index] = true; });
            const linkAfter = checkedStat(link);
            if (!linkAfter || !unchanged(linkBefore, linkAfter)) return keepAll();
          }
          const linkDirAfter = checkedStat(linkDir), familyAfter = checkedStat(familyPath);
          if (!linkDirAfter || !familyAfter || !unchanged(linkDirBefore, linkDirAfter) || !unchanged(familyBefore, familyAfter)) return keepAll();
        }
        const taskAfter = checkedStat(task);
        if (!taskAfter || !unchanged(taskBefore, taskAfter)) return keepAll();
      }
    } finally { dir.closeSync(); }
    const after = checkedStat(botRoot), parentAfter = checkedStat(TASK_WORKSPACES_DIR);
    return !after || !parentAfter || !unchanged(before, after) || !unchanged(parent, parentAfter) ? keepAll() : references;
  } catch { return keepAll(); }
}
