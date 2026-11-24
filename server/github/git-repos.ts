// Which GitHub repositories a conversation works in, for the github grant's push scope (server/bot-box/broker-github.ts
// mayPush): those its folders already hold clones of (their remotes, read from each clone's config file as text: no git
// is run, so nothing a repository configures runs), and those it cloned or fetched through the broker since this server
// started. A push to any other repository is refused. Reads are not narrowed by this.
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** How far below a folder clones are looked for, and how many folders are looked in at most. */
const DEPTH = 2;
const MAX_FOLDERS = 400;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONVERSATIONS = 2_000;
const MAX_REPOS_EACH = 500;
const SKIPPED = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "target", "dist", "build"]);

/** owner/name (lower case) of a github.com remote in any form git takes, including the broker's own address; else null. */
export function githubRepoOf(url: string): string | null {
  const value = url.trim();
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/|http:\/\/127\.0\.0\.1:\d+\/(?:g\/github|b\/[^/]+\/github)\/)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(value);
  if (!match) return null;
  const name = match[2]!;
  return name === "." || name === ".." ? null : `${match[1]}/${name}`.toLowerCase();
}

/** The remote URLs a git config file names (`url` and `pushurl` of each `[remote "…"]` section). */
export function remoteUrls(config: string): string[] {
  const urls: string[] = [];
  let inRemote = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) { inRemote = /^\[remote\s+"[^"]*"\]/i.test(line); continue; }
    if (!inRemote) continue;
    const match = /^(url|pushurl)\s*=\s*(.*)$/i.exec(line);
    if (match) urls.push(match[2]!.replace(/^"(.*)"$/, "$1"));
  }
  return urls;
}

async function readSmall(file: string): Promise<string | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** The config file of the clone at `folder`: `.git/config`, or for a worktree or submodule whose `.git` is a file, its
 * git folder's (or that folder's common one's). Links are not followed. */
async function cloneConfig(folder: string): Promise<string | null> {
  const dotGit = join(folder, ".git");
  let info;
  try { info = await lstat(dotGit); } catch { return null; }
  if (info.isDirectory()) return readSmall(join(dotGit, "config"));
  if (!info.isFile()) return null;
  const pointer = /^gitdir:\s*(.+)$/m.exec((await readSmall(dotGit)) ?? "")?.[1]?.trim();
  if (!pointer) return null;
  const gitDir = isAbsolute(pointer) ? pointer : resolve(folder, pointer);
  const own = await readSmall(join(gitDir, "config"));
  if (own !== null) return own;
  const common = (await readSmall(join(gitDir, "commondir")))?.trim();
  return common ? readSmall(join(isAbsolute(common) ? common : resolve(gitDir, common), "config")) : null;
}

/** The GitHub repositories cloned in `folders` or up to two levels below them. */
export async function reposOnDisk(folders: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const queue: Array<{ folder: string; depth: number }> = [...new Set(folders.map((folder) => resolve(folder)))].map((folder) => ({ folder, depth: 0 }));
  let visited = 0;
  while (queue.length && visited < MAX_FOLDERS) {
    const { folder, depth } = queue.shift()!;
    visited += 1;
    const config = await cloneConfig(folder);
    for (const url of config ? remoteUrls(config) : []) {
      const repo = githubRepoOf(url);
      if (repo) found.add(repo);
    }
    if (depth >= DEPTH) continue;
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIPPED.has(entry.name)) queue.push({ folder: join(folder, entry.name), depth: depth + 1 });
    }
  }
  return found;
}

const fetchedBy = new Map<string, Set<string>>();

/** What one conversation (or one process several share, keyed by its own key) may push to. */
export function conversationRepos(key: string, folders: readonly string[]): { mayPush(repo: string): Promise<boolean>; fetched(repo: string): void } {
  return {
    async mayPush(repo) {
      return fetchedBy.get(key)?.has(repo) === true || (await reposOnDisk(folders)).has(repo);
    },
    fetched(repo) {
      let repos = fetchedBy.get(key);
      if (!repos) {
        repos = new Set();
        fetchedBy.set(key, repos);
        if (fetchedBy.size > MAX_CONVERSATIONS) fetchedBy.delete(fetchedBy.keys().next().value!);
      }
      if (repos.size < MAX_REPOS_EACH) repos.add(repo);
    },
  };
}

/** Test seam: forget what conversations fetched. */
export function forgetConversationRepos(): void {
  fetchedBy.clear();
}
