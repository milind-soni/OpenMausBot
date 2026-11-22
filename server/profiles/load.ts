// Security invariant: never read a file from outside the folder. A link anywhere in its layout is a problem, and each file
// is checked after it is opened to be the very file inside the folder. Only the folder the person names may be a link.
// Known open risk: Node has no openat, so a folder swapped for a link while it is listed can lend the listing its names.
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, realpathSync, type Dir, type Dirent } from "node:fs";
import { join } from "node:path";

import {
  checkProfileFiles,
  PROFILE_FILE_MAX_BYTES,
  PROFILE_FOLDER_MAX_BYTES,
  PROFILE_FOLDER_MAX_ENTRIES,
  PROFILE_FOLDER_MAX_FILES,
  PROFILE_MAX_PROBLEMS,
  type ProfileFolder,
  type ProfileProblem,
} from "../../shared/profile-format.ts";

export interface LoadedProfileFolder extends ProfileFolder {
  root: string;
}

/** The folder itself could not be opened: not there, not a folder, or unreadable. */
export class ProfileFolderError extends Error {}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = constants.O_NONBLOCK ?? 0;
const LINK = "is a link; profiles never follow links, so put the file itself in the folder";
const KB = (bytes: number) => `${bytes / 1024} KB`;
const MB = (bytes: number) => `${bytes / 1024 / 1024} MB`;

interface Walk {
  root: string;
  wanted: string[];
  problems: ProfileProblem[];
  warnings: ProfileProblem[];
  seen: number;
  full: boolean;
}

const isRealFolder = (path: string) => {
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink();
};

function entries(walk: Walk, relative: string): Dirent[] {
  if (walk.full) return [];
  const path = join(walk.root, relative);
  let dir: Dir | undefined;
  try {
    if (!isRealFolder(path)) {
      walk.problems.push({ file: relative, message: LINK });
      return [];
    }
    dir = opendirSync(path);
    const list: Dirent[] = [];
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++walk.seen > PROFILE_FOLDER_MAX_ENTRIES) {
        walk.full = true;
        walk.problems.push({ file: ".", message: `has more than ${PROFILE_FOLDER_MAX_ENTRIES} files and folders in its layout, so the check stopped at ${relative || "."}` });
        return [];
      }
      if (!entry.name.startsWith(".")) list.push(entry);
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    walk.problems.push({ file: relative, message: `could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})` });
    return [];
  } finally {
    dir?.closeSync();
  }
}

const isLink = (walk: Walk, path: string, entry: Dirent): boolean => {
  if (!entry.isSymbolicLink()) return false;
  walk.problems.push({ file: path, message: LINK });
  return true;
};

const unexpected = (walk: Walk, path: string) => {
  if (walk.warnings.length < PROFILE_MAX_PROBLEMS) walk.warnings.push({ file: path, message: "is not a profile file, so it is ignored" });
};

function collect(walk: Walk): void {
  for (const entry of entries(walk, "")) {
    const path = entry.name;
    if (path === "org.md") {
      if (isLink(walk, path, entry)) continue;
      if (entry.isFile()) walk.wanted.push(path);
      else unexpected(walk, path);
    } else if (path === "areas" || path === "mcp") {
      if (isLink(walk, path, entry)) continue;
      if (!entry.isDirectory()) unexpected(walk, path);
      else if (path === "mcp") collectFiles(walk, "mcp", /\.md$/);
      else collectAreas(walk);
    }
  }
}

function collectFiles(walk: Walk, dir: string, name: RegExp): void {
  for (const entry of entries(walk, dir)) {
    const path = `${dir}/${entry.name}`;
    if (isLink(walk, path, entry)) continue;
    if (entry.isFile() && name.test(entry.name)) walk.wanted.push(path);
    else unexpected(walk, path);
  }
}

function collectAreas(walk: Walk): void {
  for (const area of entries(walk, "areas")) {
    const dir = `areas/${area.name}`;
    if (isLink(walk, dir, area)) continue;
    if (!area.isDirectory()) {
      unexpected(walk, dir);
      continue;
    }
    for (const entry of entries(walk, dir)) {
      const path = `${dir}/${entry.name}`;
      if (isLink(walk, path, entry)) continue;
      if (entry.name === "area.md" && entry.isFile()) walk.wanted.push(path);
      else if (entry.name === "bots" && entry.isDirectory()) collectFiles(walk, path, /\.md$/);
      else if (entry.name === "skills" && entry.isDirectory()) collectSkills(walk, path);
      else unexpected(walk, path);
    }
  }
}

function collectSkills(walk: Walk, dir: string): void {
  for (const skill of entries(walk, dir)) {
    const skillDir = `${dir}/${skill.name}`;
    if (isLink(walk, skillDir, skill)) continue;
    if (!skill.isDirectory()) {
      unexpected(walk, skillDir);
      continue;
    }
    const files = entries(walk, skillDir);
    const main = files.find((entry) => entry.name === "SKILL.md");
    if (!main) {
      walk.problems.push({ file: skillDir, message: "has no SKILL.md" });
      continue;
    }
    if (!isLink(walk, `${skillDir}/SKILL.md`, main)) walk.wanted.push(`${skillDir}/SKILL.md`);
  }
}

function isFileAt(fd: number, full: string): boolean {
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (realpathSync(full) !== full) return false;
    const there = lstatSync(full, { bigint: true });
    return opened.dev === there.dev && opened.ino === there.ino;
  } catch {
    return false;
  }
}

function readCapped(root: string, path: string): { bytes: Buffer } | { problem: string } {
  const full = join(root, path);
  const parents = path.split("/").slice(0, -1);
  let fd: number;
  try {
    for (let depth = 1; depth <= parents.length; depth++) {
      if (!isRealFolder(join(root, ...parents.slice(0, depth)))) return { problem: LINK };
    }
    fd = openSync(full, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { problem: code === "ELOOP" ? LINK : `could not be read (${code ?? "error"})` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { problem: "is not a file" };
    if (!isFileAt(fd, full)) return { problem: LINK };
    if (stat.size > PROFILE_FILE_MAX_BYTES) return { problem: `is larger than ${KB(PROFILE_FILE_MAX_BYTES)}` };
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return { bytes: bytes.subarray(0, read) };
  } finally {
    closeSync(fd);
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Loads and checks the profile folder at `folder`. Problems in its files come back in `problems`; only a folder that
 * cannot be opened at all throws. */
export function loadProfileFolder(folder: string): LoadedProfileFolder {
  let root: string;
  try {
    root = realpathSync(folder);
    if (!lstatSync(root).isDirectory()) throw new ProfileFolderError(`${folder} is not a folder`);
  } catch (error) {
    if (error instanceof ProfileFolderError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new ProfileFolderError(code === "ENOENT" ? `${folder} does not exist` : `${folder} could not be opened (${code ?? "error"})`);
  }
  const walk: Walk = { root, wanted: [], problems: [], warnings: [], seen: 0, full: false };
  collect(walk);
  if (walk.full) return { root, areas: [], bots: [], mcpServers: [], skills: [], problems: walk.problems, warnings: walk.warnings };
  if (!walk.wanted.length && !walk.problems.length) {
    const nested = entries(walk, "").find((entry) => entry.name === "edubot" && entry.isDirectory());
    if (nested) {
      walk.problems.push({ file: ".", message: `has no profiles of its own, but its edubot folder may: check ${join(folder, "edubot")}` });
      return { root, areas: [], bots: [], mcpServers: [], skills: [], problems: walk.problems, warnings: walk.warnings };
    }
  }
  if (walk.wanted.length > PROFILE_FOLDER_MAX_FILES) {
    walk.problems.push({ file: ".", message: `has ${walk.wanted.length} profile files; the most a folder may have is ${PROFILE_FOLDER_MAX_FILES}` });
    return { root, areas: [], bots: [], mcpServers: [], skills: [], problems: walk.problems, warnings: walk.warnings };
  }
  const files: Array<{ path: string; text: string }> = [];
  let total = 0;
  for (const path of walk.wanted) {
    const read = readCapped(root, path);
    if ("problem" in read) {
      walk.problems.push({ file: path, message: read.problem });
      continue;
    }
    total += read.bytes.length;
    if (total > PROFILE_FOLDER_MAX_BYTES) {
      walk.problems.push({ file: ".", message: `has profile files larger than ${MB(PROFILE_FOLDER_MAX_BYTES)} together; the check stopped at ${path}` });
      return { root, areas: [], bots: [], mcpServers: [], skills: [], problems: walk.problems, warnings: walk.warnings };
    }
    try {
      files.push({ path, text: utf8.decode(read.bytes) });
    } catch {
      walk.problems.push({ file: path, message: "is not UTF-8 text; save it as UTF-8" });
    }
  }
  const checked = checkProfileFiles(files, walk.wanted);
  return {
    root, ...checked,
    problems: [...walk.problems, ...checked.problems].slice(0, PROFILE_MAX_PROBLEMS),
    warnings: [...walk.warnings, ...checked.warnings].slice(0, PROFILE_MAX_PROBLEMS),
  };
}
