import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const AGENT_GRAPH_MAX_FILE_BYTES = 1024 * 1024;

export interface StableAgentGraphFileRead {
  absolutePath: string;
  relativePath: string;
  body: Buffer;
  sha256: string;
  info: Stats;
  parentPath: string;
  parentInfo: Stats;
}

export function agentGraphNoFollowFlag(
  platform = process.platform,
  nativeFlag: number | undefined = fsConstants.O_NOFOLLOW,
): number {
  if (typeof nativeFlag === "number" && nativeFlag !== 0) return nativeFlag;
  // Node does not expose O_NOFOLLOW on Windows. Callers must pair this zero
  // fallback with the same pre/post lstat, canonical-path, and descriptor
  // identity checks used by readStableAgentGraphFile.
  if (platform === "win32") return 0;
  throw new Error("agent graph filesystem access requires O_NOFOLLOW support");
}

function stableFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === 1 && right.nlink === 1 &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function stableWorkspace(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.isDirectory() && right.isDirectory() &&
    !left.isSymbolicLink() && !right.isSymbolicLink();
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * Read one exact file through the same fail-closed boundary used by graph
 * capability turns. Parent and final symlinks, hard links, oversized files,
 * workspace replacement, and in-read owner drift are rejected.
 */
export async function readStableAgentGraphFile(
  workspaceRoot: string,
  rawPath: string,
  maximumBytes = AGENT_GRAPH_MAX_FILE_BYTES,
  hooks: { afterPathValidation?: () => void | Promise<void> } = {},
): Promise<StableAgentGraphFileRead> {
  if (
    typeof workspaceRoot !== "string" || !workspaceRoot.trim() ||
    typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0") ||
    /^~(?:[\\/]|$)/.test(rawPath.trim()) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1
  ) throw new Error("agent graph evidence path is invalid");

  const requestedRoot = resolve(workspaceRoot);
  const requestedRootInfo = await lstat(requestedRoot);
  if (!requestedRootInfo.isDirectory() || requestedRootInfo.isSymbolicLink()) {
    throw new Error("agent graph workspace root must be a real non-symlink directory");
  }
  // Bind the canonical directory object while accepting platform aliases such
  // as Windows short names or macOS /var -> /private/var ancestors. The exact
  // selected root itself still cannot be a symlink.
  const root = await realpath(requestedRoot);
  const rootBefore = await lstat(root);
  if (!stableWorkspace(requestedRootInfo, rootBefore)) {
    throw new Error("agent graph workspace root identity changed during canonicalization");
  }
  const supplied = rawPath.trim();
  const lexicalCandidate = isAbsolute(supplied) ? resolve(supplied) : resolve(requestedRoot, supplied);
  if (!inside(requestedRoot, lexicalCandidate) || lexicalCandidate === requestedRoot) {
    throw new Error("agent graph evidence path is outside the approved workspace");
  }

  let current = requestedRoot;
  const components = relative(requestedRoot, lexicalCandidate).split(sep);
  let lexicalTarget: Stats | null = null;
  for (const [index, component] of components.entries()) {
    current = resolve(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("agent graph evidence paths cannot traverse symlinks");
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error("agent graph evidence path has a non-directory parent");
    }
    if (index === components.length - 1) lexicalTarget = info;
  }

  const candidate = await realpath(lexicalCandidate);
  const relativePath = relative(root, candidate);
  if (!inside(root, candidate) || !relativePath) {
    throw new Error("agent graph evidence path is outside the approved workspace");
  }
  const canonicalTarget = await lstat(candidate);
  if (!lexicalTarget || lexicalTarget.dev !== canonicalTarget.dev || lexicalTarget.ino !== canonicalTarget.ino) {
    throw new Error("agent graph evidence changed during canonicalization");
  }
  const parentPath = dirname(candidate);
  const parentBefore = await lstat(parentPath);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error("agent graph evidence parent must be a real directory");
  }

  // Component checks alone are not enough: a writable parent can be renamed
  // and replaced with a symlink between the final lstat above and open().
  // Bind the canonical target on both sides of the descriptor read. The
  // descriptor/path inode comparison below then rejects a parent restored to
  // a different in-workspace file after an outside target was opened.
  await hooks.afterPathValidation?.();

  const handle = await open(candidate, fsConstants.O_RDONLY | agentGraphNoFollowFlag());
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      throw new Error("agent graph evidence requires a regular single-link file");
    }
    if (before.size > maximumBytes) throw new Error("agent graph evidence exceeds the bounded file size");
    const body = await handle.readFile();
    const after = await handle.stat();
    const canonicalAfter = await realpath(candidate);
    const pathAfter = await lstat(candidate);
    const parentAfter = await lstat(parentPath);
    const rootAfter = await lstat(root);
    if (
      !stableFile(canonicalTarget, before) || !stableFile(before, after) || !stableFile(after, pathAfter) ||
      !sameCanonicalPath(canonicalAfter, candidate) ||
      !stableWorkspace(parentBefore, parentAfter) || !sameCanonicalPath(await realpath(parentPath), parentPath) ||
      !stableWorkspace(rootBefore, rootAfter) || !sameCanonicalPath(await realpath(root), root) ||
      body.byteLength !== after.size
    ) throw new Error("agent graph evidence changed while it was being read");
    return {
      absolutePath: candidate,
      relativePath: relativePath.split(sep).join("/"),
      body,
      sha256: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      info: after,
      parentPath,
      parentInfo: parentAfter,
    };
  } finally {
    await handle.close();
  }
}
