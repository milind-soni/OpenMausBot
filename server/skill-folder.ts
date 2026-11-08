// A skill folder brought in from outside: SKILL.md and every file beside it, written once into a fresh folder and
// checked by hash whenever it is used, never read or written through a link.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";

import type { SkillImportSummary, SkippedSkillFile, SkippedSkillFileReason } from "../shared/skill-import.ts";
export type { GitHubSkillOrigin } from "../shared/skill-import.ts";
import { parseSkillMd, scanSkillText, SKILL_FILE_MAX_BYTES, type ParsedSkill } from "../shared/skill-md.ts";
import { directoryEntryState } from "./skill-storage.ts";
import { readBoundedSkillFile } from "./bounded-skill-read.ts";

/** `depth` counts path segments, file name included. */
export const SKILL_FOLDER_LIMITS = { files: 200, bytes: 16 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, depth: 8 } as const;

const SKIPPED_LIST_MAX = 20;
const MAX_WARNINGS = 20;
const GENERATED = new Set(["__pycache__", "node_modules", "venv"]);
const unsafeCharacter = (char: string) => char < " " || char === "\u007f" || '<>:"|?*\\'.includes(char);
// Windows refuses these names in any folder, with or without an extension.
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;
const SCRIPT = /\.(?:sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|rb|pl|php|lua|js|mjs|cjs|ts)$/i;

/** Why `path` (relative, "/"-separated) may not be written inside a skill folder; null when it may. */
export function skillFilePathProblem(path: string, folder = false): SkippedSkillFileReason | null {
  const parts = path.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || [...part].some(unsafeCharacter) || /[. ]$/.test(part) ||
      WINDOWS_DEVICE.test(part) || Buffer.byteLength(part, "utf8") > 255) return "name";
    if (part.startsWith(".")) return "hidden";
    if (GENERATED.has(part.toLowerCase())) return "generated";
  }
  return parts.length > SKILL_FOLDER_LIMITS.depth - (folder ? 1 : 0) ? "deep" : null;
}

export const isSkillScript = (file: { path: string; executable?: boolean }): boolean =>
  Boolean(file.executable) || SCRIPT.test(file.path);

export interface FolderEntry {
  /** Relative to the skill folder, "/"-separated. */
  path: string;
  kind: "file" | "folder" | "link" | "submodule";
  size: number;
  executable?: boolean;
}

const depthOf = (path: string) => path.split("/").length;
const comparable = (path: string) => path.normalize("NFC").toLowerCase();

/** What of a folder listing comes in, SKILL.md first and shallow files before deep ones, within the limits. */
export function planSkillFolder<T extends FolderEntry>(entries: readonly T[]): { take: T[]; skipped: SkippedSkillFile[] } {
  const ordered = [...entries].sort((a, b) => depthOf(a.path) - depthOf(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const skillMd = ordered.find((entry) => entry.path === "SKILL.md" && entry.kind === "file");
  const take: T[] = skillMd ? [skillMd] : [];
  const skipped: SkippedSkillFile[] = [];
  const closed: string[] = [];
  const held = new Map<string, { spelling: string; folder: boolean }>(skillMd ? [["skill.md", { spelling: "SKILL.md", folder: false }]] : []);
  let bytes = skillMd?.size ?? 0;
  const clashes = (path: string) => {
    const parts = path.split("/");
    return parts.some((_, index) => {
      const prefix = parts.slice(0, index + 1).join("/");
      const holder = held.get(comparable(prefix));
      return holder !== undefined && (index === parts.length - 1 || !holder.folder || holder.spelling !== prefix);
    });
  };
  const hold = (path: string) => {
    const parts = path.split("/");
    parts.forEach((_, index) => {
      const prefix = parts.slice(0, index + 1).join("/");
      held.set(comparable(prefix), { spelling: prefix, folder: index < parts.length - 1 });
    });
  };
  for (const entry of ordered) {
    if (entry === skillMd || closed.some((prefix) => entry.path.startsWith(prefix))) continue;
    const skip = (reason: SkippedSkillFileReason) => skipped.push({ path: entry.kind === "folder" ? `${entry.path}/` : entry.path, reason });
    if (entry.kind === "link" || entry.kind === "submodule") {
      skip(entry.kind);
      continue;
    }
    const problem = skillFilePathProblem(entry.path, entry.kind === "folder");
    if (problem) {
      skip(problem);
      if (entry.kind === "folder") closed.push(`${entry.path}/`);
      continue;
    }
    if (entry.kind === "folder") continue;
    if (entry.size > SKILL_FOLDER_LIMITS.fileBytes) skip("large");
    else if (clashes(entry.path)) skip("duplicate");
    else if (take.length >= SKILL_FOLDER_LIMITS.files || bytes + entry.size > SKILL_FOLDER_LIMITS.bytes) skip("full");
    else {
      take.push(entry);
      bytes += entry.size;
      hold(entry.path);
    }
  }
  return { take, skipped };
}

export interface SkillFolderFile {
  path: string;
  content: string | Uint8Array;
  executable?: boolean;
}

export interface PreparedSkillFolder {
  skillMd: string;
  parsed: ParsedSkill;
  /** Beside SKILL.md, in the order they are written. */
  files: Array<{ path: string; content: Buffer; executable: boolean }>;
  warnings: string[];
  skipped: SkippedSkillFile[];
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The text of a file, or null for one that is not UTF-8 text. */
export function skillFileText(content: string | Uint8Array): string | null {
  if (typeof content === "string") return content;
  try {
    const text = decoder.decode(content);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/** The scan over SKILL.md and every text file beside it (scripts included), which can hold the same instructions. */
export function scanSkillFolder(skillMd: string, files: ReadonlyArray<{ path: string; content: string }>): string[] {
  const all = [...scanSkillText(skillMd), ...files.flatMap((file) => scanSkillText(file.content).map((warning) => `${file.path}: ${warning}`))];
  const unique = [...new Set(all)];
  return unique.length > MAX_WARNINGS ? [...unique.slice(0, MAX_WARNINGS), `${unique.length - MAX_WARNINGS} more warnings in its files`] : unique;
}

/** The storage gate: whoever supplied `files`, only what the plan admits is written. */
export const EXECUTABLE_MODE_UNSUPPORTED = "Executable skill file permissions cannot be preserved on Windows.";
export function executableSkillModeUnsupported(files: ReadonlyArray<{ executable?: boolean }>, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && files.some((file) => file.executable);
}

export function prepareSkillFolder(files: readonly SkillFolderFile[], platform: NodeJS.Platform = process.platform): PreparedSkillFolder | { error: string } {
  const entries = files.map((file) => ({ ...file, kind: "file" as const, size: Buffer.byteLength(file.content) }));
  const { take, skipped } = planSkillFolder(entries);
  const skillMdFile = take.find((file) => file.path === "SKILL.md");
  if (!skillMdFile) return { error: "no SKILL.md found at that location" };
  if (executableSkillModeUnsupported(take.filter((file) => file !== skillMdFile), platform)) return { error: EXECUTABLE_MODE_UNSUPPORTED };
  if (skillMdFile.size > SKILL_FILE_MAX_BYTES) return { error: `SKILL.md is larger than ${SKILL_FILE_MAX_BYTES / 1024}KB` };
  const skillMd = skillFileText(skillMdFile.content);
  if (skillMd === null) return { error: "SKILL.md is not UTF-8 text" };
  const parsed = parseSkillMd(skillMd);
  if ("error" in parsed) return parsed;
  const beside = take.filter((file) => file !== skillMdFile)
    .map((file) => ({ path: file.path, content: Buffer.from(file.content), executable: Boolean(file.executable) }));
  const texts = beside.flatMap((file) => {
    const text = skillFileText(file.content);
    return text === null ? [] : [{ path: file.path, content: text }];
  });
  return { skillMd, parsed, files: beside, warnings: scanSkillFolder(skillMd, texts), skipped };
}

export function skillImportSummary(
  name: string,
  files: ReadonlyArray<{ path: string; executable?: boolean }>,
  skipped: readonly SkippedSkillFile[],
): SkillImportSummary {
  return {
    name,
    files: files.length,
    scripts: files.filter(isSkillScript).length,
    skipped: skipped.slice(0, SKIPPED_LIST_MAX),
    skippedCount: skipped.length,
  };
}

/** Into `folder`, which must not exist yet: each level created as a real folder, never over or through anything. */
export function writeSkillFolder(
  folder: string,
  skillMd: string | Uint8Array,
  files: ReadonlyArray<{ path: string; content: string | Uint8Array; executable?: boolean }>,
): void {
  if (executableSkillModeUnsupported(files)) throw new Error(EXECUTABLE_MODE_UNSUPPORTED);
  mkdirSync(folder, { mode: 0o700 });
  writeFileSync(join(folder, "SKILL.md"), skillMd, { mode: 0o600, flag: "wx" });
  for (const file of files) {
    const target = resolve(folder, file.path);
    // Security: refused here too, whatever the caller checked, so no path can leave the folder.
    if (skillFilePathProblem(file.path) || relative(folder, target).split(/[\\/]/)[0] === "..") {
      throw new Error(`refusing to write ${JSON.stringify(file.path)} outside the skill folder`);
    }
    const parts = file.path.split("/");
    let at = folder;
    for (const part of parts.slice(0, -1)) {
      at = join(at, part);
      if (directoryEntryState(at) === "missing") mkdirSync(at, { mode: 0o700 });
      if (directoryEntryState(at) !== "directory") throw new Error(`${file.path} has no real folder to go in`);
    }
    writeFileSync(target, file.content, { mode: file.executable ? 0o700 : 0o600, flag: "wx" });
  }
}

function readNoFollow(path: string): Buffer | null {
  return readBoundedSkillFile(path, SKILL_FOLDER_LIMITS.fileBytes);
}

const digests = new Map<string, { key: string; sha256: string }>();

/** One hash over `paths` (the files beside SKILL.md that came in), each with its path, executable bit and bytes; null
 * when one is missing, is not a plain file, or is reached through a link at any level. SKILL.md keeps a hash of its own.
 * Security: only the files that came in are checked, so what a run adds beside them (a cache, a lockfile) leaves the
 * skill usable; a bot can add a file there, which a script may then load, but cannot change one that came in. */
export function skillFolderDigest(dir: string, paths: readonly string[], options: { remember?: boolean; captured?: readonly SkillFolderFile[] } = {}): string | null {
  if (directoryEntryState(dir) !== "directory") return null;
  const captured = options.captured && new Map(options.captured.map((file) => [file.path, file]));
  if (captured && (captured.size !== options.captured!.length || [...captured.keys()].some((path) => !paths.includes(path)))) return null;
  const folders = new Set<string>();
  const files: Array<{ path: string; full: string; executable: boolean }> = [];
  const stats: string[] = [];
  for (const path of [...paths].sort()) {
    if (skillFilePathProblem(path)) return null;
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const folder = join(dir, ...parts.slice(0, depth));
      if (folders.has(folder)) continue;
      if (directoryEntryState(folder) !== "directory") return null;
      folders.add(folder);
    }
    const full = join(dir, ...parts);
    let info;
    try {
      info = lstatSync(full);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    stats.push(`${path}\0${info.ino}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}\0${info.mode}`);
    files.push({ path, full, executable: (info.mode & 0o100) !== 0 });
  }
  const key = createHash("sha256").update(stats.join("\n")).digest("hex");
  const known = digests.get(dir);
  if (!captured && known?.key === key) return known.sha256;
  const hash = createHash("sha256");
  for (const file of files) {
    const snapshot = captured?.get(file.path);
    const bytes = snapshot ? Buffer.from(snapshot.content) : readNoFollow(file.full);
    if (bytes === null) return null;
    hash.update(`${file.path}\0${(snapshot ? Boolean(snapshot.executable) : file.executable) ? "x" : "-"}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  const sha256 = hash.digest("hex");
  if (!captured && options.remember !== false) digests.set(dir, { key, sha256 });
  return sha256;
}

export const githubSkillOriginSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string(),
});

/** What a manifest records about a folder's files beside SKILL.md: their paths, and skillFolderDigest over them. */
export const skillFolderRecordSchema = {
  files: z.array(z.string()).max(SKILL_FOLDER_LIMITS.files).optional(),
  filesSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
};
