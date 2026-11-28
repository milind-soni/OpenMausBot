import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { planSkillFolder, SKILL_FOLDER_LIMITS, SKILL_IMPORT_SKIP_REPORT_MAX, skillFilePathProblem } from "./skill-folder-plan.mjs";

const MAX_ENTRIES = 4096;
const OPEN_FILE = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

async function selectedFile(target, expected) {
  const file = await open(target, OPEN_FILE);
  try {
    const info = await file.stat();
    // The opened file must still be the listed, single-link file inside the chosen folder.
    if (!info.isFile() || info.nlink !== 1 || info.dev !== expected.dev || info.ino !== expected.ino ||
      info.size !== expected.size || await realpath(target) !== target) throw new Error("Skill file changed");
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== info.size) throw new Error("Skill file changed");
    return buffer.subarray(0, total).toString("base64");
  } finally {
    await file.close();
  }
}

/** The folder must come from the native picker. Only admitted relative names and bounded file contents leave main. */
export async function readChosenSkillFolder(chosen) {
  const missingSkill = { error: "Choose a folder containing SKILL.md." };
  const chosenInfo = await lstat(chosen);
  if (!chosenInfo.isDirectory()) return missingSkill;
  const root = await realpath(chosen);
  const rootInfo = await lstat(root);
  if (rootInfo.dev !== chosenInfo.dev || rootInfo.ino !== chosenInfo.ino || !rootInfo.isDirectory()) throw new Error("Skill folder changed");
  const skillMd = await lstat(join(root, "SKILL.md")).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!skillMd?.isFile() || skillMd.nlink !== 1) return missingSkill;
  if (skillMd.size > SKILL_FOLDER_LIMITS.fileBytes) return { error: "SKILL.md is too large to import." };
  const entries = [];
  let visited = 0;
  const walk = async (folder, prefix) => {
    if (await realpath(folder) !== folder) throw new Error("Skill folder changed");
    for await (const entry of await opendir(folder)) {
      if (++visited > MAX_ENTRIES) return false;
      const path = `${prefix}${entry.name}`;
      const target = join(folder, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) {
        entries.push({ path, kind: "link", size: 0 });
      } else if (info.isDirectory()) {
        entries.push({ path, kind: "folder", size: 0 });
        if (!skillFilePathProblem(path, true) && !await walk(target, `${path}/`)) return false;
      } else if (info.isFile()) {
        entries.push({ path, kind: "file", target, info, size: info.size, executable: (info.mode & 0o111) !== 0 });
      }
    }
    return true;
  };

  if (!await walk(root, "")) return { error: "This folder has too many entries. Choose the folder containing SKILL.md." };
  const { take, skipped } = planSkillFolder(entries);
  const entry = take[0];
  if (entry?.path !== "SKILL.md") return missingSkill;
  if (entry.size > SKILL_FOLDER_LIMITS.fileBytes) return { error: "SKILL.md is too large to import." };
  const files = [];
  for (const { path, target, info, executable } of take) {
    files.push({ path, base64: await selectedFile(target, info), executable });
  }
  const current = await lstat(root);
  if (!current.isDirectory() || current.dev !== rootInfo.dev || current.ino !== rootInfo.ino) throw new Error("Skill folder changed");
  return { files, skipped: skipped.slice(0, SKILL_IMPORT_SKIP_REPORT_MAX), skippedCount: skipped.length };
}
