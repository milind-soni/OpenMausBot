// Per-turn workspace checkpoints: a shadow git repository per bot+folder.
//
// Before a turn's engine can touch files, the working folder is snapshotted
// into a shadow repo at DATA_DIR/checkpoints/<botId>/<sha256(cwd)[..16]>/.git.
// When the turn settles, its digest diffs the folder against that snapshot to
// list the files the turn changed, added and deleted.
// The user's own .git (if the folder is a repository) is never read, written,
// or locked: every git call runs with GIT_DIR pointing at the shadow repo and
// GIT_WORK_TREE pointing at the folder, so the shadow index is the only index
// involved — and git always skips directories named .git when walking a work
// tree, so the user's repository internals are invisible to the snapshot.
//
// Ignored/excluded files (node_modules, .env, media) are never snapshotted.
//
// Failure policy: checkpointing is best-effort convenience, never load-bearing.
// Any git failure disables the feature for that bot for the rest of the
// session and logs — nothing here ever throws into the turn path. A git call
// that hits the timeout disables only that bot+folder, so a slow folder costs
// one wait and one log line, not one wait per turn.
//
// Adapted from the checkpoint designs of Cline, Roo-Code, and Gemini CLI
// (all Apache-2.0): the per-call GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* env
// override follows Gemini CLI's gitService, the sanitized GIT_* env list and
// the exclude categories follow Roo-Code's checkpoint service, and the
// snapshot-before-every-turn cadence follows Cline.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";

import { DATA_DIR } from "./config.ts";

export const CHECKPOINTS_DIR = join(DATA_DIR, "checkpoints");

/** Full sha1 hex only: accepting anything looser would let arbitrary
 * revspecs ("HEAD~3", "main@{u}") reach git. */
const COMMIT_HASH = /^[0-9a-f]{40}$/;

// What a checkpoint deliberately does not carry, so a digest never lists
// these either. Categories follow Roo-Code's checkpoint excludes: VCS
// internals, dependency trees, build output, caches, logs, secrets, media,
// archives, databases, model weights.
const EXCLUDES = `# OpenMausBot checkpoint excludes — never snapshotted
.git/
.svn/
.hg/
node_modules/
bower_components/
.pnpm-store/
.venv/
venv/
.direnv/
__pycache__/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.tox/
.gradle/
Pods/
dist/
build/
out/
.next/
.nuxt/
.output/
.svelte-kit/
target/
coverage/
.cache/
.parcel-cache/
.turbo/
.vite/
.terraform/
*.log
logs/
*.tmp
*.swp
.DS_Store
Thumbs.db
*.env*
.env
.env.*
*.pem
*.key
*.jpg
*.jpeg
*.png
*.gif
*.bmp
*.tiff
*.webp
*.ico
*.icns
*.psd
*.mp3
*.wav
*.flac
*.ogg
*.mp4
*.mov
*.avi
*.mkv
*.webm
*.zip
*.tar
*.gz
*.tgz
*.bz2
*.xz
*.7z
*.rar
*.jar
*.iso
*.dmg
*.sqlite
*.sqlite3
*.db
*.parquet
*.onnx
*.safetensors
*.gguf
`;

// gpgsign off: the user's global config may demand signing, and a shadow
// commit must never block on a passphrase prompt. Automatic GC stays off:
// explicit GC runs in the same per-folder queue as snapshots and diffs, on
// the throttle below, after the objects it drops are no longer needed.
const GITCONFIG = "[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n[gc]\n\tauto = 0\n";

/** Hard ceiling on one git call. A hung git (index lock, dead network
 * filesystem, cloud placeholders being downloaded) would otherwise jam the
 * per-repo queue for the whole session. */
const GIT_TIMEOUT_MS = 120_000;

// The snapshot is awaited before every turn's dispatch, so GC does not run on
// every snapshot: collect after this many HEAD-advancing snapshots of one
// folder, or sooner when loose objects (git's own gc.auto default) or new
// object data pile up. Counters are per process and reset on restart.
export const GC_EVERY_COMMITS = 25;
const GC_LOOSE_OBJECTS = 6_700;
const GC_NEW_DATA_KIB = 262_144;

/** One failed git call disables checkpoints for that bot until restart —
 * a broken shadow repo must cost the user one log line, not a failed turn. */
const disabledBots = new Set<string>();

function disable(botId: string, message: string): void {
  disabledBots.add(botId);
  console.warn(`workspace checkpoints disabled for bot ${botId} this session: ${message}`);
}

/** A git call that hit GIT_TIMEOUT_MS (not a cancellation). The folder is
 * too slow to snapshot — waiting that long again on every turn is worse than
 * having no checkpoint, so only that bot+folder is switched off. */
class GitTimeoutError extends Error {}

/** Bot+folder pairs (keyed by shadow dir) switched off after a timeout. */
const disabledFolders = new Set<string>();

function disableFolder(shadow: string, botId: string, worktree: string, message: string): void {
  if (disabledFolders.has(shadow)) return;
  disabledFolders.add(shadow);
  console.warn(`workspace checkpoints disabled for bot ${botId} in ${worktree} this session: ${message}`);
}

/** The shadow dir doubles as the bot+folder key. Null when the folder cannot
 * be resolved (the refusal check reports that case). */
function folderShadow(botId: string, cwd: string): { worktree: string; shadow: string } | null {
  try {
    const worktree = realpathSync(resolve(cwd));
    return { worktree, shadow: shadowDir(botId, worktree) };
  } catch {
    return null;
  }
}

// probed once: either the system has a usable git or checkpoints stay off
let gitProbe: Promise<boolean> | null = null;
function gitAvailable(): Promise<boolean> {
  gitProbe ??= new Promise((resolveProbe) => {
    execFile("git", ["--version"], { windowsHide: true, timeout: 5_000 }, (err) => resolveProbe(!err));
  });
  return gitProbe;
}

/** Folders a checkpoint must never be taken in: missing paths, the sprawling
 * personal folders (home, Desktop, Documents, Downloads), and the filesystem
 * root — snapshotting those would trawl unbounded personal data into a repo. */
export function refusalReason(cwd: string): string | null {
  if (!isAbsolute(cwd)) return "the working folder must be an absolute path";
  const requested = resolve(cwd);
  let stat;
  let dir: string;
  try {
    stat = statSync(requested);
    dir = realpathSync.native(requested);
  } catch {
    return "the working folder does not exist";
  }
  if (!stat.isDirectory()) return "the working folder is not a folder";
  // Compare canonical paths too: otherwise /tmp/home-link -> $HOME bypasses
  // the refusal while git still follows the symlink into the protected tree.
  // The native realpath also settles Windows' spellings of one folder —
  // c:\users\me, C:\Users\me\DOCUME~1 — and names compare case-insensitively
  // there.
  const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (dir === parse(dir).root) return "checkpoints are not taken at the filesystem root";
  const requestedHome = resolve(homedir());
  const home = existsSync(requestedHome) ? realpathSync.native(requestedHome) : requestedHome;
  if (same(requested, requestedHome) || same(dir, home)) return "checkpoints are not taken in the home folder";
  for (const name of ["Desktop", "Documents", "Downloads"]) {
    const requestedProtected = join(requestedHome, name);
    const protectedDir = existsSync(requestedProtected) ? realpathSync.native(requestedProtected) : requestedProtected;
    if (same(requested, requestedProtected) || same(dir, protectedDir)) {
      return `checkpoints are not taken in the ${name} folder`;
    }
  }
  return null;
}

function shadowDir(botId: string, cwd: string): string {
  const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return join(CHECKPOINTS_DIR, botId, key);
}

function gitEnv(shadow: string, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Git has several redirection/config environment variables beyond the
  // common GIT_DIR set (for example GIT_COMMON_DIR and GIT_CONFIG_KEY_*).
  // None are needed by a local shadow repo, so clear the complete namespace
  // before installing the small, explicit environment below.
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  env.GIT_DIR = join(shadow, ".git");
  env.GIT_WORK_TREE = resolve(cwd);
  env.GIT_CONFIG_GLOBAL = join(shadow, "gitconfig");
  env.GIT_CONFIG_SYSTEM = join(shadow, "gitconfig_empty");
  env.GIT_AUTHOR_NAME = "OpenMausBot Checkpoint";
  env.GIT_AUTHOR_EMAIL = "checkpoint@openmausbot.local";
  env.GIT_COMMITTER_NAME = "OpenMausBot Checkpoint";
  env.GIT_COMMITTER_EMAIL = "checkpoint@openmausbot.local";
  return env;
}

/** execFile reports its own timeout as a killed child; a cancellation via
 * `signal` arrives as an AbortError instead and is not a timeout. */
function gitFailure(command: string, err: Error & { killed?: boolean }, stderr: string, signal?: AbortSignal): Error {
  if (err.killed && err.name !== "AbortError" && !signal?.aborted) {
    return new GitTimeoutError(`git ${command} timed out after ${GIT_TIMEOUT_MS / 1000} s`);
  }
  return new Error(`git ${command}: ${(stderr || err.message).trim().slice(0, 400)}`);
}

/** Run one git command against the shadow repo. cwd is the WORK TREE — the
 * "." pathspec in add resolves relative to it. Every call carries the
 * GIT_TIMEOUT_MS hard timeout. */
function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    signal?.throwIfAborted();
    execFile(
      "git",
      args,
      { cwd, env, signal, windowsHide: true, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) rejectPromise(gitFailure(args[0]!, err, stderr, signal));
        else resolvePromise(stdout);
      },
    );
  });
}

/** `git diff --cached --quiet`: is there anything staged beyond HEAD? Used
 * instead of `status --porcelain` emptiness on purpose — a nested repo with
 * a dirty work tree shows up in status forever while staging nothing, which
 * would either commit empty churn every turn or fail the commit outright. */
function hasStagedChanges(cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolvePromise, rejectPromise) => {
    signal?.throwIfAborted();
    execFile(
      "git",
      ["diff", "--cached", "--quiet", "--ignore-submodules=dirty"],
      { cwd, env, signal, windowsHide: true, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err === null) resolvePromise(false);
        else if (err.code === 1) resolvePromise(true);
        else rejectPromise(gitFailure("diff", err, stderr, signal));
      },
    );
  });
}

// One operation at a time per shadow repo: snapshots, diffs and pin releases
// against the same folder queue behind each other (git's index lock would
// fail the loser anyway — this turns a crash into a wait). The stored tail
// never rejects, so one failed operation can't poison the queue.
const chains = new Map<string, Promise<void>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = chains.get(key) ?? Promise.resolve();
  const run = tail.then(fn);
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// A ref per running turn. Every snapshot parents only the empty base and a
// collection prunes whatever HEAD no longer reaches — so when a bot's threads
// work side by side in one folder, a collection after a sibling's snapshot
// would discard the pre-turn commit a still-running turn diffs against at its
// end. A pin keeps that commit reachable until release(). The pin's name is
// hashed so any token is a legal ref name.
const LIVE_REFS = "refs/omb-live/";
function liveRef(pin: string): string {
  return LIVE_REFS + createHash("sha256").update(pin).digest("hex").slice(0, 16);
}

// Pins outlive the process that wrote them (a crash mid-turn), so the first
// use of each shadow in this process drops every pin left behind: no turn of
// ours can be live in a shadow this process has not touched yet. Dropping one
// makes the next snapshot's collection due (see collectionDue).
const sweptShadows = new Set<string>();
const droppedPins = new Set<string>();
async function sweepLiveRefs(cwd: string, env: NodeJS.ProcessEnv, shadow: string, signal?: AbortSignal): Promise<void> {
  if (sweptShadows.has(shadow)) return;
  const stale = (await runGit(["for-each-ref", "--format=%(refname)", LIVE_REFS], cwd, env, signal)).split("\n").filter(Boolean);
  for (const ref of stale) await runGit(["update-ref", "-d", ref], cwd, env, signal);
  if (stale.length > 0) droppedPins.add(shadow);
  sweptShadows.add(shadow);
}

/** Create the shadow repo on first use; self-heal its config files on every
 * use (they are tiny, and rewriting them lets exclude-list updates reach
 * shadows that already exist). The base commit is an EMPTY marker so HEAD
 * always resolves; every snapshot parents only it. */
async function ensureShadow(cwd: string, env: NodeJS.ProcessEnv, shadow: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  mkdirSync(shadow, { recursive: true, mode: 0o700 });
  writeFileSync(join(shadow, "gitconfig"), GITCONFIG, { mode: 0o600 });
  writeFileSync(join(shadow, "gitconfig_empty"), "", { mode: 0o600 });
  if (!existsSync(join(shadow, ".git", "HEAD"))) {
    // --template= keeps the user's init.templateDir hooks/config out
    await runGit(["init", "--initial-branch=main", "--template="], cwd, env, signal);
  }
  mkdirSync(join(shadow, ".git", "info"), { recursive: true });
  writeFileSync(join(shadow, ".git", "info", "exclude"), EXCLUDES);
  // Cargo and other tools can put caches outside conventional target/ or
  // build/ paths. Honor the standard tag even for previously indexed caches.
  const tags = (await runGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "**/CACHEDIR.TAG"], cwd, env, signal)).split("\0");
  const cachePatterns = new Set<string>();
  for (const tag of tags) {
    if (!tag.includes("/") || /[\r\n]/.test(tag)) continue;
    try {
      const path = join(cwd, tag);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 4096) continue;
      if (!readFileSync(path, "utf8").startsWith("Signature: 8a477f597d28d172789f06886806bc55")) continue;
      const directory = tag.slice(0, -"CACHEDIR.TAG".length);
      cachePatterns.add("/" + directory.replace(/[\\*?[\]#! ]/g, "\\$&"));
    } catch {
      // A disappearing/unreadable tag is not evidence that a path is a cache.
    }
  }
  writeFileSync(join(shadow, ".git", "info", "exclude"), EXCLUDES + [...cachePatterns].join("\n") + "\n");
  try {
    await runGit(["rev-parse", "--verify", "HEAD"], cwd, env, signal);
  } catch {
    // brand-new repo (or a crash between init and first commit)
    await runGit(["commit", "--no-verify", "--allow-empty", "-m", "checkpoint base"], cwd, env, signal);
  }
  await sweepLiveRefs(cwd, env, shadow, signal);
}

type FolderNames = { exact: Set<string>; folded: Set<string> };

/** Folder listings in flight at once (libuv's pool has four threads). */
const LISTING_CONCURRENCY = 4;

/** Case-insensitive file systems only (APFS/HFS+ as macOS formats them,
 * NTFS): does a staged path, or one of its folders, now exist on disk under a
 * different case? git init sets core.ignorecase there, so an incremental
 * `add -A` matches `R0` to the staged `r0` and keeps the old spelling
 * forever. Reads folder listings only — each folder holding a staged path
 * once, asynchronously, so a big tree never stalls the event loop — never
 * file contents. Names compare in NFC: git stores precomposed paths on macOS,
 * readdir returns names as they were created. */
async function caseRenamed(cwd: string, paths: readonly string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  const pending = new Set<string>([""]);
  for (const path of paths) {
    for (let slash = path.indexOf("/"); slash > 0; slash = path.indexOf("/", slash + 1)) pending.add(path.slice(0, slash));
  }
  const listings = new Map<string, FolderNames | null>();
  const queue = [...pending];
  const read = async (): Promise<void> => {
    for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
      try {
        const exact = new Set((await readdir(join(cwd, dir))).map((name) => name.normalize("NFC")));
        listings.set(dir, { exact, folded: new Set([...exact].map((name) => name.toLowerCase())) });
      } catch {
        listings.set(dir, null); // gone or unreadable: add -A handles deletions itself
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LISTING_CONCURRENCY, queue.length) }, read));
  const folders = new Map<string, boolean>();
  const renamed = (path: string, isFolder: boolean): boolean => {
    const known = isFolder ? folders.get(path) : undefined;
    if (known !== undefined) return known;
    const slash = path.lastIndexOf("/");
    const parent = slash < 0 ? "" : path.slice(0, slash);
    const name = path.slice(slash + 1).normalize("NFC");
    const names = listings.get(parent) ?? null;
    let verdict: boolean;
    if (names === null) verdict = false;
    else if (!names.exact.has(name)) verdict = names.folded.has(name.toLowerCase()); // else simply deleted
    else verdict = parent !== "" && renamed(parent, true);
    if (isFolder) folders.set(path, verdict);
    return verdict;
  };
  return paths.some((path) => renamed(path, false));
}

/** Would an incremental `git add -A` leave the shadow index different from
 * one rebuilt from empty? Only in four cases, all detected here: a tracked
 * path is now ignored or inside a cache-tagged directory (add -A never drops
 * tracked files), a folder holding tracked files became a nested repository
 * (add -A keeps the files instead of a gitlink), a recorded nested
 * repository lost its .git (add -A keeps the stale gitlink), or — on a
 * case-insensitive file system — a tracked path was renamed by case only
 * (add -A keeps the old spelling). */
async function indexNeedsRebuild(cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean> {
  // If the index cannot be inspected (say, a listing past maxBuffer on a huge
  // folder), rebuild: that is always correct, just slower.
  const list = (args: string[]) => runGit(args, cwd, env, signal).catch((e: unknown) => {
    if (e instanceof GitTimeoutError || signal?.aborted) throw e;
    return null;
  });
  const ignored = await list(["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"]);
  if (ignored === null || ignored.length > 0) return true;
  const staged = await list(["ls-files", "--stage", "-z"]);
  if (staged === null) return true;
  const paths: string[] = [];
  const parents = new Set<string>();
  for (const entry of staged.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const path = entry.slice(tab + 1);
    paths.push(path);
    if (entry.startsWith("160000 ")) {
      if (!existsSync(join(cwd, path, ".git"))) return true;
      continue;
    }
    for (let slash = path.indexOf("/"); slash > 0; slash = path.indexOf("/", slash + 1)) parents.add(path.slice(0, slash));
  }
  for (const dir of parents) if (existsSync(join(cwd, dir, ".git"))) return true;
  return (process.platform === "darwin" || process.platform === "win32") && (await caseRenamed(cwd, paths));
}

/** Stage the work tree into the shadow index. The index persists between
 * snapshots so `git add -A` only re-reads files whose stat data changed;
 * rebuilding it from empty re-reads and re-hashes every file (and downloads
 * every cloud placeholder). It is rebuilt only when indexNeedsRebuild says an
 * incremental add would differ, so the staged content always matches a
 * from-empty rebuild. Only the shadow index changes; no user index or
 * work-tree file does. */
async function stageWorkTree(cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (await indexNeedsRebuild(cwd, env, signal)) await runGit(["read-tree", "--empty"], cwd, env, signal);
  await runGit(["add", "-A", "--ignore-errors", "."], cwd, env, signal);
}

/** `advanced`: HEAD moved to a new commit. `compacted`: that move also
 * dropped legacy multi-commit history. */
type CommitResult = { hash: string; advanced: boolean; compacted: boolean };

/** Capture fully before advancing HEAD: null when the add was partial, so a
 * partial capture never replaces the last usable checkpoint or authorizes
 * removal of its objects. */
async function commitAll(cwd: string, env: NodeJS.ProcessEnv, label: string, signal?: AbortSignal): Promise<CommitResult | null> {
  const previous = (await runGit(["rev-parse", "HEAD"], cwd, env, signal)).trim();
  try {
    await stageWorkTree(cwd, env, signal);
  } catch (e) {
    // A timeout is not an unreadable file: the caller switches the folder off.
    if (e instanceof GitTimeoutError) throw e;
    return null;
  }
  const changed = await hasStagedChanges(cwd, env, signal);
  const base = (await runGit(["rev-list", "--max-parents=0", "HEAD"], cwd, env, signal)).trim();
  const count = (await runGit(["rev-list", "--count", "HEAD"], cwd, env, signal)).trim();
  if (!changed && Number(count) <= 2) return { hash: previous, advanced: false, compacted: false };
  const tree = (await runGit(["write-tree"], cwd, env, signal)).trim();
  const message = changed ? label : (await runGit(["show", "-s", "--format=%B", "HEAD"], cwd, env, signal)).trim();
  // Parent only the empty marker, never the previous snapshot: keeping the
  // previous commit as an ancestor would retain every old tree indefinitely.
  const hash = (await runGit(["commit-tree", tree, "-p", base, "-m", message], cwd, env, signal)).trim();
  await runGit(["update-ref", "HEAD", hash, previous], cwd, env, signal);
  return { hash, advanced: true, compacted: Number(count) > 2 };
}

/** HEAD-advancing snapshots per shadow since this process last collected. */
const commitsSinceGc = new Map<string, number>();

/** Pack size (KiB) first counted after the last collection — the live
 * snapshot. Packs also grow between collections: `git add` streams files over
 * core.bigFileThreshold straight into new packs. */
const packBaselineKib = new Map<string, number>();

/** A collection the throttle asked for, held until that turn's settled diff
 * has been queued, or — when the turn settled without one — until the next
 * snapshot, which runs it first (see snapshot and diffWorkingTree). */
const pendingCollections = new Map<string, () => Promise<void>>();

/** Queue the folder's pending collection behind whatever was just queued for
 * it. Nothing awaits it. */
function releaseCollection(shadow: string): void {
  const collect = pendingCollections.get(shadow);
  if (collect === undefined) return;
  pendingCollections.delete(shadow);
  void serialize(shadow, collect);
}

/** Throttle for collectObsolete (see GC_EVERY_COMMITS). */
async function collectionDue(shadow: string, result: CommitResult, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean> {
  // A compaction or a swept leftover pin frees a whole tree at once: reclaim it now.
  const freed = droppedPins.delete(shadow) || result.compacted;
  if (!result.advanced && !freed) return false;
  const commits = (commitsSinceGc.get(shadow) ?? 0) + (result.advanced ? 1 : 0);
  commitsSinceGc.set(shadow, commits);
  let due = freed || commits >= GC_EVERY_COMMITS;
  if (!due) {
    // Advisory only: a failed count must not cost the snapshot just taken.
    const counted = await runGit(["count-objects", "-v"], cwd, env, signal).catch(() => "");
    if (counted !== "") {
      const field = (name: string) => Number(new RegExp(`^${name}: (\\d+)$`, "m").exec(counted)?.[1] ?? 0);
      const pack = field("size-pack");
      if (!packBaselineKib.has(shadow)) packBaselineKib.set(shadow, pack);
      // Every loose object is new since the last collection (gc packs or
      // prunes them all). Only pack growth counts, so a folder whose live
      // snapshot alone passes the ceiling does not collect every turn.
      const newData = field("size") + Math.max(0, pack - packBaselineKib.get(shadow)!);
      due = field("count") >= GC_LOOSE_OBJECTS || newData >= GC_NEW_DATA_KIB;
    }
  }
  if (due) {
    commitsSinceGc.set(shadow, 0);
    packBaselineKib.delete(shadow);
  }
  return due;
}

async function collectObsolete(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  // No caller may still need an unpinned previous tree: HEAD stays reachable,
  // and so does every commit a live turn still pins.
  try {
    await runGit(["reflog", "expire", "--expire=now", "--all"], cwd, env);
    await runGit(["gc", "--prune=now", "--quiet"], cwd, env);
  } catch {
    // A busy/full disk must not hide an otherwise usable snapshot.
    console.warn("checkpoint cleanup deferred; the latest snapshot is preserved");
  }
}

/** Snapshot the folder. Returns the checkpoint hash, or null when the
 * feature is off for this bot or folder, git is missing, the folder is
 * refused, or a file could not be read.
 * With `pin`, the returned commit stays reachable through later snapshots of
 * the same folder until release(pin) — for a turn that will diff against it
 * when it ends. Never throws — this is called fire-and-forget on the turn path. */
export async function snapshot(botId: string, cwd: string, label: string, signal?: AbortSignal, opts?: { pin?: string }): Promise<string | null> {
  if (signal?.aborted) return null;
  if (disabledBots.has(botId)) return null;
  if (!(await gitAvailable())) return null;
  if (refusalReason(cwd) !== null) return null;
  const folder = folderShadow(botId, cwd);
  if (folder === null || disabledFolders.has(folder.shadow)) return null;
  const { worktree, shadow } = folder;
  try {
    // Still pending from the previous snapshot: that turn settled without a
    // diff. Collect ahead of this snapshot, not behind it, so this turn's own
    // diff never queues behind GC and the object counts below see the
    // collected repo (a stale count would make GC due again at once).
    releaseCollection(shadow);
    return await serialize(shadow, async () => {
      const env = gitEnv(shadow, worktree);
      await ensureShadow(worktree, env, shadow, signal);
      const result = await commitAll(worktree, env, label, signal);
      if (!result) return null;
      if (opts?.pin) await runGit(["update-ref", liveRef(opts.pin), result.hash], worktree, env, signal);
      // Never awaited by the turn waiting on this snapshot, and held for that
      // turn's settled diff: diffWorkingTree queues it behind itself, so GC
      // never eats into the digest's capture window.
      if (await collectionDue(shadow, result, worktree, env, signal)) {
        pendingCollections.set(shadow, () => collectObsolete(worktree, env));
      }
      return result.hash;
    });
  } catch (e) {
    if (signal?.aborted) return null;
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof GitTimeoutError) disableFolder(shadow, botId, worktree, message);
    else disable(botId, message);
    return null;
  }
}

/** Let go of a pinned pre-turn commit: the next collection may reclaim it.
 * Queued behind the shadow's pending operations, so a digest's diff already
 * in that queue still finds its commit. Best-effort like the
 * rest of this module — a pin that cannot be dropped costs one log line and
 * is swept on the next start. */
export async function release(botId: string, cwd: string, pin: string): Promise<void> {
  if (!(await gitAvailable())) return;
  try {
    const worktree = realpathSync(resolve(cwd));
    const shadow = shadowDir(botId, worktree);
    if (!existsSync(join(shadow, ".git", "HEAD"))) return;
    const env = gitEnv(shadow, worktree);
    await serialize(shadow, () => runGit(["update-ref", "-d", liveRef(pin)], worktree, env));
  } catch (e) {
    console.warn(`checkpoint pin not released for bot ${botId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface CheckpointDiff {
  changed: string[];
  added: string[];
  deleted: string[];
}

/** Diff the settled workspace without replacing its pre-turn snapshot.
 * Staging is confined to the shadow index; the user's files and Git are untouched. */
export async function diffWorkingTree(botId: string, cwd: string, fromHash: string, signal?: AbortSignal): Promise<CheckpointDiff | null> {
  if (signal?.aborted || !COMMIT_HASH.test(fromHash)) return null;
  if (disabledBots.has(botId) || !(await gitAvailable()) || refusalReason(cwd) !== null) return null;
  const folder = folderShadow(botId, cwd);
  if (folder === null || disabledFolders.has(folder.shadow)) return null;
  const { worktree, shadow } = folder;
  try {
    const env = gitEnv(shadow, worktree);
    const run = serialize(shadow, async () => {
      await ensureShadow(worktree, env, shadow, signal);
      await stageWorkTree(worktree, env, signal);
      const out = await runGit(["diff", "--cached", "--name-status", "--no-renames", "-z", fromHash], worktree, env, signal);
      const diff: CheckpointDiff = { changed: [], added: [], deleted: [] };
      const fields = out.split("\0").filter((field) => field.length > 0);
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const status = fields[i]!;
        const path = fields[i + 1]!;
        if (status.startsWith("A")) diff.added.push(path);
        else if (status.startsWith("D")) diff.deleted.push(path);
        else diff.changed.push(path);
      }
      return diff;
    });
    // The collection this turn's snapshot left pending runs behind this
    // diff, never ahead of it.
    releaseCollection(shadow);
    return await run;
  } catch (e) {
    if (e instanceof GitTimeoutError && !signal?.aborted) disableFolder(shadow, botId, worktree, e.message);
    return null;
  }
}
