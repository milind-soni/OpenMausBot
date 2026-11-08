import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { workspaceDir } from "./workspace.ts";

const comparable = (path: string) => {
  const value = resolve(path).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? value.toLowerCase() : value;
};
const state = (path: string) => {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "unsafe"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe"; }
};
const inside = (root: string, path: string) => {
  const rest = relative(comparable(root), comparable(path));
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
};

/** Uncertain native links keep the previous revision. */
export function nativeSkillLinksMayReferTo(botId: string, name: string, target: string): boolean {
  const root = workspaceDir(botId);
  for (const family of [".claude", ".agents", ".grok"]) {
    const familyDir = join(root, family);
    if (state(familyDir) === "missing") continue;
    if (state(familyDir) !== "directory") return true;
    const linkDir = join(familyDir, "skills");
    if (state(linkDir) === "missing") continue;
    if (state(linkDir) !== "directory") return true;
    const link = join(linkDir, name);
    try {
      if (!lstatSync(link).isSymbolicLink()) return true;
      const raw = resolve(dirname(link), readlinkSync(link).replace(/^\\\\\?\\/, ""));
      if (inside(target, raw)) return true;
      let actual: string;
      try { actual = realpathSync(link); } catch { return true; }
      let physicalTarget: string;
      try { physicalTarget = realpathSync(target); } catch { physicalTarget = target; }
      if (inside(physicalTarget, actual)) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}
