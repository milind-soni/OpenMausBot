import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SendTurnInput } from "../contracts.ts";
import { readFileNoFollow } from "../imported-skills.ts";
import { SKILL_FOLDER_LIMITS, skillFilePathProblem, skillFolderDigest, writeSkillFolder } from "../skill-folder.ts";
import { directoryEntryState } from "../skill-storage.ts";

const PROMPT_FIELDS = ["text", "system", "systemStable", "systemVolatile", "recoveryText"] as const;

function stagedSkillMatches(target: string, paths: string[], hash: string): boolean {
  const expected = new Set(paths);
  const folders = new Set(paths.flatMap((path) => path.split("/").slice(0, -1).map((_, index) => path.split("/").slice(0, index + 1).join("/"))));
  const visit = (folder: string, prefix = ""): boolean => {
    if (directoryEntryState(folder) !== "directory") return false;
    return readdirSync(folder).every((name) => {
      const path = prefix + name;
      const full = join(folder, name);
      const info = lstatSync(full);
      return info.isDirectory() ? folders.has(path) && visit(full, path + "/") : info.isFile() && expected.has(path);
    });
  };
  return visit(target) && skillFolderDigest(target, paths, { remember: false }) === hash;
}

/** Antigravity c57db0a9 permits GEMINI_HOME. Stage in its server-owned profile, never in a replaceable task directory. */
export function stageAntigravitySkills(turn: SendTurnInput, profile: string): SendTurnInput {
  const result: SendTurnInput = { ...turn, skillFiles: [] };
  const stagedFiles: string[] = [];
  for (const file of new Set(turn.skillFiles ?? [])) {
    const quoted = JSON.stringify(file);
    if (!PROMPT_FIELDS.some((field) => result[field]?.includes(quoted))) continue;
    const source = dirname(file);
    const files: Array<{ path: string; content: Buffer; executable: boolean }> = [];
    let bytes = 0;
    const visit = (folder: string, prefix = "") => {
      if (directoryEntryState(folder) !== "directory") throw new Error("Antigravity skill folders must be real directories.");
      for (const name of readdirSync(folder).sort()) {
        const path = prefix + name;
        const full = join(folder, name);
        const info = lstatSync(full);
        if (skillFilePathProblem(path, info.isDirectory())) throw new Error("Antigravity skill contains an unsafe path.");
        if (info.isDirectory()) { visit(full, path + "/"); continue; }
        if (!info.isFile() || info.size > SKILL_FOLDER_LIMITS.fileBytes) throw new Error("Antigravity skill contains an unsafe file.");
        const content = readFileNoFollow(full, SKILL_FOLDER_LIMITS.fileBytes);
        if (!content) throw new Error("Antigravity skill file could not be read.");
        bytes += content.length;
        if (files.length >= SKILL_FOLDER_LIMITS.files || bytes > SKILL_FOLDER_LIMITS.bytes) throw new Error("Antigravity skill exceeds folder limits.");
        files.push({ path, content, executable: (info.mode & 0o100) !== 0 });
      }
    };
    visit(source);
    const skillMd = files.find((entry) => entry.path === "SKILL.md");
    if (!skillMd) throw new Error("Antigravity skill has no SKILL.md.");
    skillMd.executable = false;
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const digest = createHash("sha256");
    for (const entry of files) digest.update(entry.path + "\0" + (entry.executable ? "x" : "-") + "\0" + createHash("sha256").update(entry.content).digest("hex") + "\n");
    const hash = digest.digest("hex");
    if (directoryEntryState(profile) === "missing") mkdirSync(profile, { recursive: true, mode: 0o700 });
    if (directoryEntryState(profile) !== "directory") throw new Error("Antigravity profile must be a real directory.");
    const root = join(realpathSync(profile), "omb-skills");
    if (directoryEntryState(root) === "missing") mkdirSync(root, { recursive: true, mode: 0o700 });
    if (directoryEntryState(root) !== "directory") throw new Error("Antigravity staging path must be a real directory.");
    const target = join(root, hash);
    if (directoryEntryState(target) === "missing") {
      const temporary = mkdtempSync(join(root, ".stage-"));
      try {
        const prepared = join(temporary, "skill");
        writeSkillFolder(prepared, skillMd.content, files.filter((entry) => entry !== skillMd));
        try { renameSync(prepared, target); }
        catch (error) {
          if (!stagedSkillMatches(target, files.map((entry) => entry.path), hash)) throw error;
        }
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
    if (!stagedSkillMatches(target, files.map((entry) => entry.path), hash)) {
      throw new Error("Antigravity staged skill files changed.");
    }
    stagedFiles.push(join(target, "SKILL.md"));
    for (const field of PROMPT_FIELDS) {
      if (result[field] !== undefined) result[field] = result[field]!.replaceAll(quoted, JSON.stringify(join(target, "SKILL.md")));
    }
  }
  result.skillFiles = stagedFiles;
  return result;
}
