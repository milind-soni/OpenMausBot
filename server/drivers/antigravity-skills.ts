import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SendTurnInput } from "../contracts.ts";
import { readFileNoFollow } from "../imported-skills.ts";
import { SKILL_FOLDER_LIMITS, skillFilePathProblem, skillFolderDigest, writeSkillFolder } from "../skill-folder.ts";
import { directoryEntryState } from "../skill-storage.ts";

const PROMPT_FIELDS = ["text", "system", "systemStable", "systemVolatile", "recoveryText"] as const;

/** Antigravity c57db0a9 resolves links before restricting view_file to cwd and GEMINI_HOME. */
export function stageAntigravitySkills(turn: SendTurnInput, cwd: string): SendTurnInput {
  const result = { ...turn };
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
        const content = readFileNoFollow(full);
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
    const root = join(realpathSync(cwd), ".omb-skills");
    if (directoryEntryState(root) === "missing") mkdirSync(root, { mode: 0o700 });
    if (directoryEntryState(root) !== "directory") throw new Error("Antigravity staging path must be a real directory.");
    const target = join(root, hash);
    if (directoryEntryState(target) === "missing") {
      const temporary = mkdtempSync(join(root, ".stage-"));
      try {
        const prepared = join(temporary, "skill");
        writeSkillFolder(prepared, skillMd.content, files.filter((entry) => entry !== skillMd));
        try { renameSync(prepared, target); }
        catch (error) {
          if (skillFolderDigest(target, files.map((entry) => entry.path), { remember: false }) !== hash) throw error;
        }
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
    if (skillFolderDigest(target, files.map((entry) => entry.path), { remember: false }) !== hash) {
      throw new Error("Antigravity staged skill files changed.");
    }
    for (const field of PROMPT_FIELDS) {
      if (result[field] !== undefined) result[field] = result[field]!.replaceAll(quoted, JSON.stringify(join(target, "SKILL.md")));
    }
  }
  return result;
}
