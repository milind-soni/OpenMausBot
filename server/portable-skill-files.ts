import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isPortableSkillPath, skillCompanionsSchema, SKILL_BUNDLE_FILE_MAX_BYTES, SKILL_BUNDLE_MAX_BYTES, SKILL_BUNDLE_MAX_FILES } from "../shared/package-format.ts";
import { isUtf8Text } from "../shared/portable-skill-bundle.ts";
import { SKILL_FILE_MAX_BYTES } from "../shared/skill-md.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { prepareSkillFolder } from "./skill-folder.ts";

export type PortableSkillFile = { path: string; content: string };
export type PortableSkillSkip = { path: string; reason: "skill_file_type" | "skill_file_unsafe" | "skill_file_limit" };
export type PortableSkillFiles = { files: PortableSkillFile[]; skipped: PortableSkillSkip[] };
const MAX_VISITED = 512;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024, MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function preparePackageSkill(skillMd: string, files: PortableSkillFile[]) {
  if (!skillCompanionsSchema.safeParse(files).success) return { error: "invalid skill files" };
  const folder = prepareSkillFolder([{ path: "SKILL.md", content: skillMd }, ...files]);
  if ("error" in folder) return folder;
  if (folder.skipped.length) return { error: "invalid skill files" };
  return { files: [{ path: "SKILL.md", content: skillMd }], parsed: folder.parsed, warnings: folder.warnings, skippedFiles: [], folder: folder.files };
}

export function portableSkillFilesFromMemory(input: ReadonlyArray<{ path: string; content: Uint8Array | string }>): PortableSkillFiles {
  const files: PortableSkillFile[] = [], skipped: PortableSkillSkip[] = [];
  for (const entry of [...input].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (entry.path === "SKILL.md") continue;
    let content: string | null;
    try { content = typeof entry.content === "string" ? entry.content : decoder.decode(entry.content); } catch { content = null; }
    const reason = !/\.md$/i.test(entry.path) || content === null || !isUtf8Text(content) ? "skill_file_type"
      : !isPortableSkillPath(entry.path) ? "skill_file_unsafe" : "skill_file_limit";
    const file = content === null ? null : { path: entry.path, content };
    if (reason !== "skill_file_limit" || !file || !skillCompanionsSchema.safeParse([...files, file]).success) {
      skipped.push({ path: redactSecretsInText(entry.path), reason });
    } else files.push(file);
  }
  return { files, skipped };
}

export function snapshotPortableSkill(root: string, verifiedText: () => string | null): (PortableSkillFiles & { instructions: string }) | null {
  let fd: number | null = null;
  try {
    if (!lstatSync(root).isDirectory()) return null;
    const path = join(root, "SKILL.md"), before = lstatSync(path);
    if (!before.isFile() || before.nlink > 1 || before.size > SKILL_FILE_MAX_BYTES) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null;
    const instructions = decoder.decode(readFileSync(fd));
    const contents = readPortableSkillFiles(root);
    if (!contents || verifiedText() !== instructions || verifiedText() !== instructions) return null;
    return { instructions, ...contents };
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

/** Reads only bounded Markdown, never intentionally following links; changed directories or files refuse the snapshot. */
export function readPortableSkillFiles(root: string): PortableSkillFiles | null {
  const files: PortableSkillFile[] = [], skipped: PortableSkillSkip[] = [];
  let visited = 0, bytes = 0, sourceBytes = 0, failed = false;
  const skip = (path: string, reason: PortableSkillSkip["reason"]) => skipped.push({ path: redactSecretsInText(path), reason });
  const walk = (directory: string, prefix: string): void => {
    if (failed) return;
    let before;
    try { before = lstatSync(directory); } catch { failed = true; return; }
    if (!before.isDirectory() || before.isSymbolicLink()) { failed = true; return; }
    const names: string[] = [];
    try {
      const handle = opendirSync(directory);
      try {
        for (;;) {
          const entry = handle.readSync();
          if (!entry) break;
          if (++visited > MAX_VISITED) { failed = true; break; }
          names.push(entry.name);
        }
      } finally { handle.closeSync(); }
      names.sort();
      for (const name of names) {
        if (failed) break;
        const path = prefix ? `${prefix}/${name}` : name;
        if (path === "SKILL.md") continue;
        const full = join(directory, name);
        const info = lstatSync(full);
        if (info.isFile() && (info.size > MAX_SOURCE_FILE_BYTES || (sourceBytes += info.size) > MAX_SOURCE_BYTES)) { failed = true; break; }
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1) || (!info.isDirectory() && !info.isFile())) { skip(path, "skill_file_unsafe"); continue; }
        if (info.isDirectory()) {
          if (!isPortableSkillPath(`${path}/x.md`)) { skip(`${path}/`, "skill_file_unsafe"); continue; }
          walk(full, path);
          continue;
        }
        if (!/\.md$/i.test(path)) { skip(path, "skill_file_type"); continue; }
        if (!isPortableSkillPath(path)) { skip(path, "skill_file_unsafe"); continue; }
        if (files.length >= SKILL_BUNDLE_MAX_FILES || info.size > SKILL_BUNDLE_FILE_MAX_BYTES || bytes + info.size > SKILL_BUNDLE_MAX_BYTES) {
          skip(path, "skill_file_limit"); continue;
        }
        let fd: number | null = null;
        try {
          fd = openSync(full, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
          const opened = fstatSync(fd);
          if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) { failed = true; continue; }
          const data = readFileSync(fd);
          const after = fstatSync(fd);
          if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || data.length !== info.size) { failed = true; continue; }
          let content: string;
          try { content = decoder.decode(data); } catch { skip(path, "skill_file_type"); continue; }
          if (content.includes("\0")) { skip(path, "skill_file_type"); continue; }
          const candidate = { path, content };
          if (!skillCompanionsSchema.safeParse([...files, candidate]).success) { skip(path, "skill_file_limit"); continue; }
          files.push(candidate); bytes += data.length;
        } finally { if (fd !== null) closeSync(fd); }
      }
      const after = lstatSync(directory);
      if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) failed = true;
    } catch { failed = true; }
  };
  walk(root, "");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return failed ? null : { files, skipped };
}
