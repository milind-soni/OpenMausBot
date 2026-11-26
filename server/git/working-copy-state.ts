// Whether a git working copy can be deleted without losing anything: the safe-deletion rule a storage cleanup will use.
// Nothing calls it yet. It only reads: it never fetches, never runs gc, never refreshes or writes the index, and runs no
// program the repository names.
//
// A folder is "disposable" only when ALL of these hold, for its own working tree and, when it is the main checkout, every
// linked worktree of the same repository that still exists on disk:
// - `git status` shows nothing: untracked files that are not ignored count as work (an untracked folder that is its own
//   repository shows there too). Files ignored by the repository's .gitignore files or .git/info/exclude (node_modules,
//   build output, and also an ignored .env) do not count, with one exception: an ignored folder that holds a nested
//   repository (a .git entry anywhere inside it, found by a bounded walk) is work ("nested-repo"), and a walk that hits its
//   bound is "unknown".
// - every commit reachable from any local ref or HEAD (branches, tags, detached HEADs of every worktree, notes; `--all`
//   without the stash, so stricter than branches alone) is on a remote-tracking ref of a remote whose address is off this
//   disk (https, ssh, git, or user@host:path). A remote that is a folder or a file:// address does not count, and a
//   repository with no such remote is never disposable. Both the fetch and the push addresses must be off the disk (a push
//   to a folder would move refs/remotes/<name>/* and make commits look pushed), and when one remote's name is another's plus
//   "/…" (origin and origin/backup share refs/remotes/origin/…) the answer is "unknown".
// - from the main checkout, each linked worktree's HEAD and refs/worktree/* are on a remote too. A "commits" reason says
//   whether the commits are on a branch, tag or other ref shared by the repository ("repository") or only on this working
//   tree's HEAD or refs/worktree/* ("this-worktree").
// - there is no stash, and no rebase, merge, cherry-pick, revert or bisect in progress.
// - no index entry is marked assume-unchanged, and no skip-worktree entry has a file on disk (git status skips both).
// - every checked-out submodule is itself disposable (judged the same way, up to 3 levels), points at the commit the parent
//   records, and no submodule repository is kept in .git/modules without a checkout.
// A folder with no .git entry is "not-a-repo" (a bare repository's folder is "unknown"). A subfolder of a working tree, or a
// plain folder that holds repositories further down, has no .git entry, so it is "not-a-repo" too: a caller must never read
// "not-a-repo" as "safe to delete", and must only ask about a repository's top folder.
//
// Reasons carry counts and kinds, never file names (a detail is safe to log); `path` is the working tree it was found in.
//
// LIMITS, plainly:
// - It is for clones a bot made in its own working folders, never for a person's own folders.
// - "disposable" is a statement about the repository's own local records. A bot that controls the folder can forge them:
//   write refs/remotes/origin/x itself, point origin at any https address, or ignore everything in .gitignore. So the caller
//   (storage cleanup) combines this with idle time and never applies it to a person's main work folder.
// - It judges one folder. A linked worktree's own folder is judged with the repository-wide checks but without its sibling
//   worktrees (deleting it does not delete them); the main checkout is judged with all of them, since its .git holds theirs.
// - Reflogs are not read: commits reachable only from a reflog (a reset-away branch tip) are not counted as work.
//
// Hostile configuration: the repository's .git/config is written by a bot, so it must not make this function run a program
// or hide work. Every git call here:
// - runs with an environment stripped of GIT_* and pager/askpass variables, GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL=/dev/null
//   (only the repository's own config is read, and only for data), GIT_OPTIONAL_LOCKS=0 plus --no-optional-locks (no index
//   refresh writes), GIT_NO_LAZY_FETCH and protocol.allow=never (a partial clone cannot fetch, so no ssh, ext:: or
//   uploadpack program), --no-pager, --no-replace-objects, and GIT_CEILING_DIRECTORIES at the folder's parent.
// - overrides on the command line: core.fsmonitor=false, core.hooksPath=/dev/null, core.pager=cat, credential.helper=,
//   core.alternateRefsCommand=, log.showSignature=false, submodule.recurse=false, core.excludesFile=/dev/null, and the
//   settings that hide changes (core.ignoreStat, core.checkStat, core.trustctime).
// - lists the repository's config first and blanks every filter.<name>.clean/smudge/process (with required=false),
//   diff.<name>.textconv/command and merge.<name>.driver it names, then lists it again at the end and answers "unknown" if it
//   changed in between (the window a running bot could otherwise use).
// - uses only commands that never call a pager, signature program, editor, alias or hook: rev-parse, config --list, remote,
//   status (with --untracked-files=normal, --ignore-submodules=dirty so no git runs inside a submodule with the parent's
//   overrides, --no-renames), rev-list, for-each-ref, ls-files and worktree list. Submodules are opened one by one with
//   their own config listed and blanked the same way.
// - does not trust safe.directory from anywhere but git's own default: a repository owned by another user is refused by git
//   and answered "unknown".
// Any git error, timeout (one deadline across every call, default 30 s), unreadable repository, unexpected output or a git
// older than 2.36 (which would ignore GIT_CONFIG_COUNT, so the driver blanking) is "unknown", which is never disposable.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { OWN_GROUP, stopGroup } from "../group-exec.ts";

export type WorkKind = "changes" | "commits" | "stash" | "in-progress" | "no-remote" | "hidden-changes" | "submodule" | "worktree" | "nested-repo";
/** `scope` only on "commits": on a ref the repository shares, or only on this working tree's HEAD or refs/worktree/*. */
export type WorkReason = { kind: WorkKind; path: string; detail: string; scope?: "repository" | "this-worktree" };
export type WorkingCopyState =
  | { state: "not-a-repo" }
  | { state: "disposable" }
  | { state: "has-unpushed-work"; reasons: WorkReason[] }
  | { state: "unknown"; detail: string };

export type WorkingCopyOptions = {
  /** One deadline across every git call. */
  timeoutMs?: number;
  /** The git command line prefix; tests swap in a stand-in. */
  git?: readonly string[];
  /** How many folders the walk of ignored folders for nested repositories may open before answering "unknown". */
  maxIgnoredFolders?: number;
};

export function isDisposable(state: WorkingCopyState): boolean {
  return state.state === "disposable";
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SUBMODULE_DEPTH = 3;
const MAX_SUBMODULES = 50;
const MAX_LISTING_BYTES = 64 * 1024 * 1024;
const MAX_IGNORED_FOLDERS = 50_000;
const MAX_IGNORED_DEPTH = 40;

class Unknown extends Error {}

const STATIC_OVERRIDES = [
  "core.fsmonitor=false", "core.hooksPath=/dev/null", "core.pager=cat", "credential.helper=", "core.alternateRefsCommand=",
  "protocol.allow=never", "log.showSignature=false", "submodule.recurse=false", "core.excludesFile=/dev/null",
  "core.ignoreStat=false", "core.checkStat=default", "core.trustctime=true", "core.untrackedCache=false", "gc.auto=0",
  "maintenance.auto=false", "core.useReplaceRefs=false",
];
/** Config keys whose value is a program git may run while reading a working tree. */
const DRIVER_KEY = /^(filter)\.(.+)\.(clean|smudge|process|required)$|^(diff)\.(.+)\.(textconv|command)$|^(merge)\.(.+)\.(driver)$/s;
const IN_PROGRESS: Array<[string, string]> = [
  ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"], ["sequencer", "cherry-pick or revert"], ["BISECT_LOG", "bisect"], ["BISECT_START", "bisect"],
];

/** The environment every git call gets: nothing inherited that git reads, nothing that names a program. */
export function gitEnvironment(folder: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dropped = /^(GIT_|SSH_ASKPASS$|PAGER$|LESS$|EDITOR$|VISUAL$|XDG_CONFIG_HOME$)/i;
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !dropped.test(name)));
  return {
    ...kept,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_PAGER: "cat", PAGER: "cat",
    GIT_CEILING_DIRECTORIES: dirname(folder), LC_ALL: "C",
  };
}

/** Blank every driver program the repository's config names (`git config --list -z` output). */
export function driverOverrides(listing: string): Record<string, string> {
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  const add = (key: string, value: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const index = seen.size - 1;
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  };
  for (const entry of listing.split("\0")) {
    const key = entry.split("\n", 1)[0]!;
    const match = DRIVER_KEY.exec(key);
    if (!match) continue;
    if (match[1]) {
      for (const name of ["clean", "smudge", "process"]) add(`filter.${match[2]}.${name}`, "");
      add(`filter.${match[2]}.required`, "false");
    }
    if (match[4]) {
      add(`diff.${match[5]}.textconv`, "");
      add(`diff.${match[5]}.command`, "");
    }
    if (match[7]) add(`merge.${match[8]}.driver`, "");
  }
  return seen.size ? { ...env, GIT_CONFIG_COUNT: String(seen.size) } : {};
}

/** True when a remote address is off this disk (https, http, ssh, git, or scp-like user@host:path); a folder or file:// is not. */
export function remoteIsOffDisk(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase();
  if (scheme) return ["https", "http", "ssh", "git", "git+ssh", "ssh+git"].includes(scheme);
  if (/^[a-z]:[\\/]/i.test(url) || url.includes("::")) return false;
  // scp-like: a colon before the first slash.
  const colon = url.indexOf(":");
  return colon > 0 && (url.indexOf("/") === -1 || colon < url.indexOf("/"));
}

/** `git version` output names 2.36 or later. */
export function gitIsRecentEnough(version: string): boolean {
  const match = /git version (\d+)\.(\d+)/.exec(version);
  return Boolean(match) && (Number(match![1]) > 2 || (Number(match![1]) === 2 && Number(match![2]) >= 36));
}

/** Two locations are the same folder: git prints C:/x/y on Windows where Node has C:\x\y, and Windows ignores case. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (value: string) => {
    let out = value.replace(/\\/g, "/").replace(/\/+$/, "");
    if (platform === "win32") out = out.toLowerCase();
    return out;
  };
  return norm(a) === norm(b);
}

function real(path: string): string {
  return realpathSync.native(path);
}

type Run = (cwd: string, args: string[], options?: { allowExit?: number[]; stopAfterBytes?: number }) => Promise<{ code: number; stdout: string }>;
type Context = { run: Run; overrides: Map<string, Record<string, string>>; deadline: number; ignoredFolders: { left: number }; covered: Set<string> };

function runner(options: WorkingCopyOptions): Context {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const [command, ...prefix] = options.git ?? ["git"];
  const overrides = new Map<string, Record<string, string>>();
  const run: Run = (cwd, args, { allowExit = [0], stopAfterBytes } = {}) => new Promise((done, fail) => {
    const left = deadline - Date.now();
    if (left <= 0) return fail(new Unknown("git did not answer in time"));
    const full = [...prefix, "--no-pager", "--no-optional-locks", "--no-replace-objects",
      ...STATIC_OVERRIDES.flatMap((setting) => ["-c", setting]), ...args];
    const child = spawn(command!, full, { cwd, env: { ...gitEnvironment(cwd), ...overrides.get(cwd) }, stdio: ["ignore", "pipe", "pipe"], ...OWN_GROUP });
    let stdout = "", stderr = "", truncated = false, settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => { stopGroup(child, 0); settle(() => fail(new Unknown("git did not answer in time"))); }, left);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      const cap = stopAfterBytes ?? MAX_LISTING_BYTES;
      if (stdout.length > cap && !truncated) {
        truncated = true;
        stopGroup(child, 0);
        if (stopAfterBytes) settle(() => done({ code: 0, stdout }));
        else settle(() => fail(new Unknown(`git ${args[0]} wrote too much`)));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < 4_000) stderr += chunk; });
    child.once("error", (error) => settle(() => fail(new Unknown(`git could not run: ${error.message}`))));
    child.once("close", (code, signal) => settle(() => {
      if (signal || code === null || !allowExit.includes(code)) fail(new Unknown(`git ${args[0]} failed: ${stderr.trim().split("\n").at(-1) || `exit ${code ?? signal}`}`));
      else done({ code, stdout });
    }));
  });
  return { run, overrides, deadline, ignoredFolders: { left: options.maxIgnoredFolders ?? MAX_IGNORED_FOLDERS }, covered: new Set() };
}

/** Walks an ignored folder for a .git entry, without following links. True when one is found. */
async function holdsRepository(ctx: Context, start: string): Promise<boolean> {
  const stack: Array<[string, number]> = [[start, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop()!;
    if (Date.now() > ctx.deadline) throw new Unknown("git did not answer in time");
    if (--ctx.ignoredFolders.left < 0) throw new Unknown("too many ignored folders to look through for nested repositories");
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { throw new Unknown("an ignored folder could not be read"); }
    for (const entry of entries) {
      if (entry.name === ".git") return true;
      if (!entry.isDirectory()) continue;
      if (depth + 1 > MAX_IGNORED_DEPTH) throw new Unknown("ignored folders nested too deeply to look through");
      stack.push([join(dir, entry.name), depth + 1]);
    }
  }
  return false;
}

type Tree = { path: string; gitDir: string; commonDir: string };

/** rev-parse in `folder`, which must be the top of its own working tree. */
async function openTree(ctx: Context, folder: string): Promise<Tree> {
  const { stdout } = await ctx.run(folder, ["rev-parse", "--path-format=absolute", "--is-bare-repository", "--show-toplevel", "--git-dir", "--git-common-dir"]);
  const [bare, top, gitDir, commonDir] = stdout.split("\n");
  if (bare !== "false" || !top || !gitDir || !commonDir) throw new Unknown("not a working tree");
  if (!samePath(real(top), folder)) throw new Unknown("git's working tree for this folder is another folder");
  ctx.overrides.set(folder, driverOverrides((await ctx.run(folder, ["config", "--list", "-z"])).stdout));
  return { path: folder, gitDir: real(gitDir), commonDir: real(commonDir) };
}

async function configUnchanged(ctx: Context, folder: string): Promise<void> {
  const now = driverOverrides((await ctx.run(folder, ["config", "--list", "-z"])).stdout);
  if (JSON.stringify(now) !== JSON.stringify(ctx.overrides.get(folder))) throw new Unknown("the repository's config changed while it was read");
}

/** Remotes whose fetch and push addresses are all off this disk. */
async function offDiskRemotes(ctx: Context, folder: string): Promise<{ names: string[]; offDisk: string[] }> {
  const names = (await ctx.run(folder, ["remote"])).stdout.split("\n").filter(Boolean);
  // refs/remotes/origin/* holds origin/backup's refs too: which remote a ref belongs to can't be told apart.
  if (names.some((name) => names.some((other) => other.startsWith(`${name}/`)))) throw new Unknown("one remote's name is another's plus /…");
  const offDisk: string[] = [];
  for (const name of names) {
    const fetch = (await ctx.run(folder, ["remote", "get-url", "--all", name])).stdout.split("\n").filter(Boolean);
    const push = (await ctx.run(folder, ["remote", "get-url", "--push", "--all", name])).stdout.split("\n").filter(Boolean);
    if (fetch.length && push.length && [...fetch, ...push].every(remoteIsOffDisk)) offDisk.push(name);
  }
  return { names, offDisk };
}

const any = async (ctx: Context, cwd: string, args: string[]) => (await ctx.run(cwd, ["rev-list", "--max-count=1", ...args])).stdout.trim() !== "";
/** Every ref the repository shares, as rev-list arguments: not the stash, remote-tracking, per-worktree or bisect refs. */
const SHARED_REFS = ["--exclude=refs/stash", "--exclude=refs/remotes/*", "--exclude=refs/worktree/*", "--exclude=refs/bisect/*", "--glob=refs/*"];

/** Commits on no off-disk remote, seen from `tree`: on a ref the repository shares, or only on this tree's HEAD and refs/worktree/*. */
async function commitReasons(ctx: Context, tree: Tree, offDisk: string[]): Promise<WorkReason[]> {
  const remotes = offDisk.map((name) => `--remotes=${name}`);
  const reasons: WorkReason[] = [];
  if (await any(ctx, tree.path, [...SHARED_REFS, "--not", ...remotes])) {
    reasons.push({ kind: "commits", scope: "repository", path: tree.path, detail: "commits on a branch, tag or other shared ref that are on no remote" });
  }
  const born = (await ctx.run(tree.path, ["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [0, 1] })).code === 0;
  if (await any(ctx, tree.path, [...(born ? ["HEAD"] : []), "--glob=refs/worktree/*", "--not", ...SHARED_REFS, ...remotes])) {
    reasons.push({ kind: "commits", scope: "this-worktree", path: tree.path, detail: "commits only on this working tree's HEAD or refs/worktree/*, on no remote" });
  }
  return reasons;
}

/** What one working tree holds that is not in a commit: changes, hidden entries, nested repositories, an operation, submodules. */
async function treeReasons(ctx: Context, tree: Tree, depth: number): Promise<WorkReason[]> {
  const reasons: WorkReason[] = [];
  const status = await ctx.run(tree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=dirty", "--no-renames"], { stopAfterBytes: 64 * 1024 });
  const changed = status.stdout.split("\0").filter(Boolean).length;
  if (changed) reasons.push({ kind: "changes", path: tree.path, detail: `${changed}${changed > 1000 ? "+" : ""} uncommitted or untracked file(s) or folder(s)` });
  for (const [file, operation] of IN_PROGRESS) {
    if (existsSync(join(tree.gitDir, file))) { reasons.push({ kind: "in-progress", path: tree.path, detail: `a ${operation} is in progress` }); break; }
  }
  // An ignored folder that is, or holds, a repository of its own: its commits are nowhere in this one.
  let nested = 0;
  for (const entry of (await ctx.run(tree.path, ["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"])).stdout.split("\0").filter(Boolean)) {
    const path = resolve(tree.path, entry);
    let folder = false;
    try { folder = lstatSync(path).isDirectory(); } catch {}
    if (folder && await holdsRepository(ctx, path)) nested++;
  }
  if (nested) reasons.push({ kind: "nested-repo", path: tree.path, detail: `${nested} ignored folder(s) holding a repository of their own` });
  const entries = (await ctx.run(tree.path, ["ls-files", "-s", "-v", "-z"])).stdout.split("\0").filter(Boolean);
  const gitlinks: Array<{ path: string; sha: string }> = [];
  let hidden = 0;
  for (const entry of entries) {
    const match = /^(\S) (\d{6}) ([0-9a-f]{40,64}) \d\t(.+)$/s.exec(entry);
    if (!match) throw new Unknown("unexpected ls-files output");
    const [, tag, mode, sha, path] = match as unknown as [string, string, string, string, string];
    if (/[a-z]/.test(tag)) hidden++;
    else if (tag === "S" && existsSync(join(tree.path, path))) hidden++;
    if (mode === "160000") gitlinks.push({ path, sha });
  }
  if (hidden) reasons.push({ kind: "hidden-changes", path: tree.path, detail: `${hidden} file(s) marked assume-unchanged or skip-worktree that git status does not check` });
  if (gitlinks.length > MAX_SUBMODULES) throw new Unknown("too many submodules");
  for (const link of gitlinks) {
    const path = resolve(tree.path, link.path);
    if (!existsSync(join(path, ".git"))) {
      if (existsSync(path) && readdirSync(path).length) throw new Unknown("a submodule folder has files but no repository");
      continue;
    }
    if (depth >= MAX_SUBMODULE_DEPTH) throw new Unknown("submodules nested too deeply");
    const subFolder = real(path);
    const sub = await judge(ctx, subFolder, depth + 1);
    if (sub.state === "unknown") throw new Unknown(`a submodule: ${sub.detail}`);
    if (sub.state === "not-a-repo") throw new Unknown("a submodule is not a repository");
    if (sub.state === "has-unpushed-work") reasons.push({ kind: "submodule", path, detail: sub.reasons.map((reason) => reason.detail).join("; ") });
    const head = (await ctx.run(subFolder, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
    if (head !== link.sha) reasons.push({ kind: "changes", path: tree.path, detail: "a submodule is at a commit the parent has not recorded" });
  }
  return reasons;
}

/** Repository directories under <git dir>/modules, not descending into one once found. */
function moduleRepositories(dir: string, depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return [];
  if (existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects"))) return [real(dir)];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => moduleRepositories(join(dir, entry.name), depth + 1));
}

async function judge(ctx: Context, folder: string, depth: number): Promise<WorkingCopyState> {
  const tree = await openTree(ctx, folder);
  ctx.covered.add(tree.gitDir);
  const reasons: WorkReason[] = [];
  const { names, offDisk } = await offDiskRemotes(ctx, folder);
  if (!offDisk.length) reasons.push({ kind: "no-remote", path: folder, detail: names.length ? "its only remotes are folders on this disk" : "it has no remote" });
  else {
    reasons.push(...await commitReasons(ctx, tree, offDisk));
  }
  if ((await ctx.run(folder, ["for-each-ref", "--count=1", "--format=%(refname)", "refs/stash"])).stdout.trim()) reasons.push({ kind: "stash", path: folder, detail: "a stash" });
  reasons.push(...await treeReasons(ctx, tree, depth));
  let commitsSeen = reasons.some((reason) => reason.kind === "commits");
  // The main checkout's .git holds every linked worktree's state: judge those trees too, with their own HEAD and refs/worktree/*.
  const listing = (await ctx.run(folder, ["worktree", "list", "--porcelain", "-z"])).stdout.split("\0");
  const worktrees = listing.filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
  if (worktrees[0] && existsSync(worktrees[0]) && samePath(real(worktrees[0]), folder)) {
    for (const other of worktrees.slice(1)) {
      if (!existsSync(other)) continue;
      const linked = await openTree(ctx, real(other));
      ctx.covered.add(linked.gitDir);
      const own = offDisk.length ? (await commitReasons(ctx, linked, offDisk)).filter((reason) => reason.scope === "this-worktree") : [];
      commitsSeen ||= own.length > 0;
      const found = [...own, ...await treeReasons(ctx, linked, depth)];
      if (found.length) reasons.push({ kind: "worktree", path: linked.path, detail: found.map((reason) => reason.detail).join("; ") });
      await configUnchanged(ctx, linked.path);
    }
  }
  // What neither check saw: another working tree's HEAD, such as one whose folder is gone.
  if (offDisk.length && !commitsSeen && await any(ctx, folder, ["--exclude=refs/stash", "--all", "--not", ...offDisk.map((name) => `--remotes=${name}`)])) {
    reasons.push({ kind: "commits", scope: "repository", path: folder, detail: "commits on another working tree's HEAD that are on no remote" });
  }
  // A submodule repository kept in .git/modules without a checkout may hold commits that are nowhere else.
  for (const dir of new Set([join(tree.commonDir, "modules"), join(tree.gitDir, "modules")])) {
    for (const repository of moduleRepositories(dir)) {
      if (!ctx.covered.has(repository)) throw new Unknown("a submodule repository in .git/modules has no checkout to judge");
    }
  }
  await configUnchanged(ctx, folder);
  return reasons.length ? { state: "has-unpushed-work", reasons } : { state: "disposable" };
}

/** Whether `folder` (the top folder of a clone a bot made) can be deleted with nothing lost. Never throws; read-only. */
export async function workingCopyState(folder: string, options: WorkingCopyOptions = {}): Promise<WorkingCopyState> {
  try {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) return { state: "unknown", detail: "the folder is missing" };
    const root = real(folder);
    try { lstatSync(join(root, ".git")); } catch {
      // A bare repository's folder holds commits but no .git entry.
      if (existsSync(join(root, "HEAD")) && existsSync(join(root, "objects"))) return { state: "unknown", detail: "a bare repository" };
      return { state: "not-a-repo" };
    }
    const ctx = runner(options);
    // Older git ignores GIT_CONFIG_COUNT (so the driver blanking) and lacks `worktree list -z`.
    if (!gitIsRecentEnough((await ctx.run(root, ["version"])).stdout)) return { state: "unknown", detail: "git is older than 2.36" };
    return await judge(ctx, root, 0);
  } catch (error) {
    return { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
  }
}
