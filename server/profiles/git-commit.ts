// Security invariant: reads only the checkout's own `.git` folder, or a linked worktree's folder under its repository's
// git folder once both of git's own back-links agree. Every read is of a regular file, opened without following a link
// or blocking on a pipe, and capped; anything else reads as no commit.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const SMALL = 64 * 1024;
const PACKED_REFS_MAX = 4 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REF = /^refs\/[\w./-]+$/;
const MAX_LEVELS = 64;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const lstat = (path: string) => {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return null;
  }
};

/** A folder that is no link, nor under one. */
function realFolder(path: string): boolean {
  if (!lstat(path)?.isDirectory()) return false;
  try {
    return realpathSync(path) === path;
  } catch {
    return false;
  }
}

/** The text of the regular file at `base/...parts`, every folder on the way a real folder; null otherwise. */
function readIn(base: string, parts: readonly string[], max: number): string | null {
  for (let depth = 1; depth < parts.length; depth++) if (!lstat(join(base, ...parts.slice(0, depth)))?.isDirectory()) return null;
  const path = join(base, ...parts);
  const before = lstat(path);
  if (!before?.isFile() || before.size > BigInt(max)) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, READ_FLAGS);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > BigInt(max)) return null;
    const buffer = Buffer.alloc(Number(stat.size));
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const pathIn = (text: string | null, from: string) => {
  const value = text?.trim();
  return value ? resolve(from, value) : null;
};

interface GitDirs {
  gitDir: string;
  commonDir: string;
}

/** A linked worktree's `.git` file names `<repository git folder>/worktrees/<name>`; that folder's `gitdir` names this
 * `.git` file back and its `commondir` names the repository's git folder. */
function linkedWorktree(dotGit: string): GitDirs | null {
  const pointer = readIn(dirname(dotGit), [basename(dotGit)], SMALL)?.match(/^gitdir:[ \t]*(.+?)[ \t]*$/m)?.[1];
  if (!pointer) return null;
  const gitDir = isAbsolute(pointer) ? resolve(pointer) : resolve(dirname(dotGit), pointer);
  const commonDir = dirname(dirname(gitDir));
  if (basename(dirname(gitDir)) !== "worktrees" || !realFolder(gitDir) || !realFolder(commonDir)) return null;
  if (pathIn(readIn(gitDir, ["commondir"], SMALL), gitDir) !== commonDir) return null;
  if (pathIn(readIn(gitDir, ["gitdir"], SMALL), gitDir) !== dotGit) return null;
  return { gitDir, commonDir };
}

/** The git folders of the checkout holding `folder`, or null when unsure. */
function gitDirsOf(folder: string): GitDirs | null {
  let dir: string;
  try {
    dir = realpathSync(folder);
  } catch {
    return null;
  }
  for (let level = 0; level < MAX_LEVELS; level++) {
    const dotGit = join(dir, ".git");
    const stat = lstat(dotGit);
    if (stat?.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
    if (stat?.isFile()) return linkedWorktree(dotGit);
    if (stat) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function refIn({ gitDir, commonDir }: GitDirs, ref: string): string | null {
  for (const dir of gitDir === commonDir ? [gitDir] : [gitDir, commonDir]) {
    const loose = readIn(dir, ref.split("/"), SMALL)?.trim();
    if (loose && SHA.test(loose)) return loose;
  }
  const packed = readIn(commonDir, ["packed-refs"], PACKED_REFS_MAX) ?? "";
  for (const line of packed.split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && sha && SHA.test(sha)) return sha;
  }
  return null;
}

/** The commit checked out in the git repository holding `folder`, read from `.git` without running git; undefined
 * when the folder is not in a checkout, or its HEAD cannot be read safely. */
export function gitCommitOf(folder: string): string | undefined {
  const dirs = gitDirsOf(folder);
  if (!dirs) return undefined;
  const head = readIn(dirs.gitDir, ["HEAD"], SMALL)?.trim();
  if (!head) return undefined;
  if (SHA.test(head)) return head;
  const ref = head.match(/^ref:\s*(\S+)$/)?.[1];
  if (!ref || !REF.test(ref) || ref.split("/").some((part) => part === ".." || part === "." || part === "")) return undefined;
  return refIn(dirs, ref) ?? undefined;
}
