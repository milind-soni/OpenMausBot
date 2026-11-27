// Sentinel's files live outside the data dir it scans: it never writes where it only reads, and backups never carry them.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

const FOLDER = "openmausbot-sentinel";

export function defaultSentinelOut(dataDir: string, platform: NodeJS.Platform = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const path = platform === "win32" ? win32 : posix;
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, ".local", "state");
  const base = platform === "darwin" ? path.join(home, "Library", "Application Support", FOLDER)
    : platform === "win32" ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), FOLDER)
    : path.join(state, FOLDER);
  // two workspaces never count into one set of issues
  const resolved = path.resolve(dataDir);
  if (resolved === path.join(home, ".openmausbot")) return base;
  return path.join(base, `data-${createHash("sha256").update(resolved).digest("hex").slice(0, 12)}`);
}

/** A link into a repository or the data dir is judged by where it leads. */
export function resolveThroughLinks(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

function enclosingRepo(dir: string): string | null {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return null;
  }
}

/** Issues name bots and threads, so they never go inside a repository, and the data dir is read-only to Sentinel. */
export function outRefusal(out: string, dataDir: string): string | null {
  const target = resolveThroughLinks(out);
  const repo = enclosingRepo(target);
  if (repo) return `refusing to write issues inside the git repository at ${repo}; pass --out with a folder outside it`;
  if (isInside(target, resolveThroughLinks(dataDir))) return `refusing to write issues inside the data dir ${dataDir}; leave out --out for the default, or pass a folder outside it`;
  return null;
}

export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const path = platform === "win32" ? win32 : posix;
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
