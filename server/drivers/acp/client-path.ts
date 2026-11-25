import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
};

export async function resolveAcpClientPath(requestPath: unknown, cwd: string, readRoots: readonly string[] = []): Promise<string> {
  if (typeof requestPath !== "string" || !isAbsolute(requestPath)) throw new Error("ACP file paths must be absolute.");
  const requested = resolve(requestPath);
  const stagedRoot = readRoots.find((allowed) => inside(resolve(allowed), requested));
  if (stagedRoot) {
    const expected = resolve(stagedRoot);
    const info = await lstat(expected);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(expected) !== expected) {
      throw new Error("ACP staged read root must be a real directory at its expected location.");
    }
  }
  const root = [cwd, ...readRoots].find((allowed) => inside(resolve(allowed), requested));
  if (!root) throw new Error("ACP file path is outside the session workspace.");
  const workspace = await realpath(root).catch(() => resolve(root));
  const suffix = [basename(requested)];
  let ancestor = dirname(requested);
  while (!(await lstat(ancestor).catch(() => null))) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("ACP file path has no accessible parent.");
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  const candidate = resolve(await realpath(ancestor), ...suffix);
  if (!inside(workspace, candidate)) throw new Error("ACP file path is outside the session workspace.");
  const existing = await lstat(candidate).catch(() => null);
  if (existing?.isSymbolicLink()) throw new Error("ACP file path cannot be a symbolic link.");
  return candidate;
}
