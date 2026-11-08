import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync } from "node:fs";
import { join } from "node:path";

import { isPortableFolderPath, isUtf8Text, portableFolderFilesSchema, SKILL_FOLDER_FILE_MAX_BYTES, SKILL_FOLDER_MAX_BYTES, SKILL_FOLDER_MAX_FILES, type PortableFolderFile } from "../shared/portable-skill-bundle.ts";
import { SKILL_FILE_MAX_BYTES } from "../shared/skill-md.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { prepareSkillFolder } from "./skill-folder.ts";
import { secretName } from "./skill-secret-names.ts";
import { readBoundedSkillDescriptor } from "./bounded-skill-read.ts";

export type PortableSkillFile = PortableFolderFile;
export type PortableSkillSkip = { path: string; reason: "skill_file_type" | "skill_file_unsafe" | "skill_file_limit" | "skill_file_binary" | "skill_file_unreviewed" };
export type PortableSkillFiles = { files: PortableSkillFile[]; skipped: PortableSkillSkip[] };
const MAX_VISITED = 512;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024, MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function portableFilesForDisk(files: readonly PortableSkillFile[]) {
  return files.map((file) => "content" in file ? file : { path: file.path, content: Buffer.from(file.binary.base64, "base64") });
}

export function selectPortableFiles(files: readonly PortableSkillFile[], includeBinary: boolean): PortableSkillFiles {
  return {
    files: files.filter((file) => includeBinary || "content" in file),
    skipped: includeBinary ? [] : files.flatMap((file) => "binary" in file ? [{ path: file.path, reason: "skill_file_binary" as const }] : []),
  };
}

function portableFile(path: string, bytes: Uint8Array, executable: boolean): PortableSkillFile | null {
  try {
    const content = decoder.decode(bytes);
    if (isUtf8Text(content)) return { path, content, ...(executable ? { executable: true as const } : {}) };
  } catch {}
  return executable ? null : { path, binary: { base64: Buffer.from(bytes).toString("base64") } };
}

const privatePath = (path: string) => path.split("/").some(secretName);
const omittedPath = (path: string) => {
  const redacted = redactSecretsInText(path);
  if (redacted.length <= 512) return redacted;
  const prefix = redacted.slice(0, 511);
  return `${/[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix}…`;
};

export function preparePackageSkill(skillMd: string, files: PortableSkillFile[]) {
  if (!portableFolderFilesSchema.safeParse(files).success) return { error: "invalid skill files" };
  const folder = prepareSkillFolder([{ path: "SKILL.md", content: skillMd }, ...portableFilesForDisk(files)]);
  if ("error" in folder) return folder;
  if (folder.skipped.length) return { error: "invalid skill files" };
  return { files: [{ path: "SKILL.md", content: skillMd }], parsed: folder.parsed, warnings: folder.warnings, skippedFiles: [], folder: folder.files };
}

export function portableSkillFilesFromMemory(input: ReadonlyArray<{ path: string; content: Uint8Array | string; executable?: boolean }>): PortableSkillFiles {
  const files: PortableSkillFile[] = [], skipped: PortableSkillSkip[] = [];
  for (const entry of [...input].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (entry.path === "SKILL.md") continue;
    const bytes = Buffer.from(entry.content);
    const safe = isPortableFolderPath(entry.path) && !privatePath(entry.path);
    const file = safe && bytes.length <= SKILL_FOLDER_FILE_MAX_BYTES && (typeof entry.content !== "string" || isUtf8Text(entry.content))
      ? portableFile(entry.path, bytes, Boolean(entry.executable)) : null;
    const reason = !safe ? "skill_file_unsafe" : bytes.length > SKILL_FOLDER_FILE_MAX_BYTES ? "skill_file_limit" : "skill_file_type";
    if (!file || !portableFolderFilesSchema.safeParse([...files, file]).success) {
      skipped.push({ path: omittedPath(entry.path), reason: file ? "skill_file_limit" : reason });
    } else files.push(file);
  }
  return { files, skipped };
}

export function snapshotPortableSkill(root: string, verifiedText: () => string | null, reviewedPaths?: readonly string[]): (PortableSkillFiles & { instructions: string }) | null {
  let fd: number | null = null;
  try {
    if (!lstatSync(root).isDirectory()) return null;
    const path = join(root, "SKILL.md"), before = lstatSync(path);
    if (!before.isFile() || before.nlink > 1 || before.size > SKILL_FILE_MAX_BYTES) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null;
    const bytes = readBoundedSkillDescriptor(fd, before.size), after = fstatSync(fd);
    if (!bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return null;
    const instructions = decoder.decode(bytes);
    const contents = readPortableSkillFiles(root, reviewedPaths);
    if (!contents || verifiedText() !== instructions || verifiedText() !== instructions) return null;
    return { instructions, ...contents };
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

/** Reads bounded files without following links; changed directories or files refuse the snapshot. */
export function readPortableSkillFiles(root: string, reviewedPaths?: readonly string[]): PortableSkillFiles | null {
  const files: PortableSkillFile[] = [], skipped: PortableSkillSkip[] = [];
  const reviewed = reviewedPaths && new Set(reviewedPaths);
  let visited = 0, bytes = 0, sourceBytes = 0, failed = false;
  const skip = (path: string, reason: PortableSkillSkip["reason"]) => skipped.push({ path: omittedPath(path), reason });
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
        if (secretName(name)) { skip(path, "skill_file_unsafe"); continue; }
        const full = join(directory, name);
        const info = lstatSync(full);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1) || (!info.isDirectory() && !info.isFile())) { skip(path, "skill_file_unsafe"); continue; }
        if (info.isDirectory()) {
          if (!isPortableFolderPath(`${path}/x`)) { skip(`${path}/`, "skill_file_unsafe"); continue; }
          walk(full, path);
          continue;
        }
        if (reviewed && !reviewed.has(path)) { skip(path, "skill_file_unreviewed"); continue; }
        if (info.size > MAX_SOURCE_FILE_BYTES || (sourceBytes += info.size) > MAX_SOURCE_BYTES) { failed = true; break; }
        if (!isPortableFolderPath(path)) { skip(path, "skill_file_unsafe"); continue; }
        if (files.length >= SKILL_FOLDER_MAX_FILES || info.size > SKILL_FOLDER_FILE_MAX_BYTES || bytes + info.size > SKILL_FOLDER_MAX_BYTES) {
          skip(path, "skill_file_limit"); continue;
        }
        let fd: number | null = null;
        try {
          fd = openSync(full, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
          const opened = fstatSync(fd);
          if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) { failed = true; continue; }
          const data = readBoundedSkillDescriptor(fd, info.size);
          const after = fstatSync(fd);
          if (!data || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) { failed = true; continue; }
          const candidate = portableFile(path, data, Boolean(info.mode & 0o100));
          if (!candidate) { skip(path, "skill_file_type"); continue; }
          if (!portableFolderFilesSchema.safeParse([...files, candidate]).success) { skip(path, "skill_file_limit"); continue; }
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
