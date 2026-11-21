// Per-turn workspace checkpoints: a shadow git repository per bot+folder.
// The user's own .git is never read, written or locked: every git call sets GIT_DIR to the shadow repo and GIT_WORK_TREE to the folder.
// Best-effort: nothing here throws into the turn path; a git failure turns checkpoints off for that bot, a timeout for that folder.
//
// Adapted from the checkpoint designs of Cline, Roo-Code, and Gemini CLI
// (all Apache-2.0): the per-call GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* env
// override follows Gemini CLI's gitService, the sanitized GIT_* env list and
// the exclude categories follow Roo-Code's checkpoint service, and the
// snapshot-before-every-turn cadence follows Cline.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { DATA_DIR } from "./config.ts";
import { execFileInGroup } from "./group-exec.ts";
import { checkpointGitSlots } from "./job-slots.ts";

export const CHECKPOINTS_DIR = join(DATA_DIR, "checkpoints");

/** Full sha1 hex only, so no revspec ("HEAD~3", "main@{u}") reaches git. */
const COMMIT_HASH = /^[0-9a-f]{40}$/;

// What a checkpoint never carries, so a digest never lists it; categories follow Roo-Code's checkpoint excludes.
const EXCLUDES = `# OpenMausBot checkpoint excludes — never snapshotted
.git/
.svn/
.hg/
.openmausbot-secrets/
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

// gpgsign off so a user's global signing config never blocks on a passphrase; auto GC off because GC runs in the per-folder queue.
const GITCONFIG = "[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n[gc]\n\tauto = 0\n";

const GIT_TIMEOUT_MS = 120_000;

export const GC_EVERY_COMMITS = 25;
const GC_LOOSE_OBJECTS = 6_700;
const GC_NEW_DATA_KIB = 262_144;

class GitTimeoutError extends Error {}

const disabledFolders = new Set<string>();

function disableFolder(shadow: string, botId: string, worktree: string, message: string): void {
  if (disabledFolders.has(shadow)) return;
  disabledFolders.add(shadow);
  console.warn(`workspace checkpoints disabled for bot ${botId} in ${worktree} this session: ${message}`);
}

/** Snapshots of a folder that failed one after another. One failure costs that turn its checkpoint and nothing else; this
 * many in a row turn the folder off for the session, and never the bot's other folders. */
export const FAILURES_BEFORE_OFF = 3;
const failedInARow = new Map<string, number>();

function snapshotFailed(shadow: string, botId: string, worktree: string, message: string): void {
  const failures = (failedInARow.get(shadow) ?? 0) + 1;
  failedInARow.set(shadow, failures);
  // The next use looks again for a lock a stopped git left.
  locksCleared.delete(shadow);
  if (failures >= FAILURES_BEFORE_OFF) disableFolder(shadow, botId, worktree, message);
  else console.warn(`workspace checkpoint not taken for bot ${botId} in ${worktree}: ${message}`);
}

function folderShadow(botId: string, cwd: string): { worktree: string; shadow: string } | null {
  try {
    const worktree = realpathSync(resolve(cwd));
    return { worktree, shadow: shadowDir(botId, worktree) };
  } catch {
    return null;
  }
}

let gitProbe: Promise<boolean> | null = null;
function gitAvailable(): Promise<boolean> {
  gitProbe ??= new Promise((resolveProbe) => {
    execFile("git", ["--version"], { windowsHide: true, timeout: 5_000 }, (err) => resolveProbe(!err));
  });
  return gitProbe;
}

/** Never home, Desktop, Documents, Downloads or the root: that would trawl unbounded personal data into a repo. */
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
  // Canonical paths too: a symlink to $HOME would bypass the refusal, and Windows has 8.3 spellings and case-insensitive names.
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

// The index file a shadow's git calls use: `index`, or the one leaveLockedIndex() moved it to.
const INDEX_POINTER = "omb-index";
const INDEX_NAME = /^index(-[a-z0-9]{1,16})?$/;
const indexNames = new Map<string, string>();
function indexName(shadow: string): string {
  let name = indexNames.get(shadow);
  if (name === undefined) {
    try {
      name = readFileSync(join(shadow, ".git", INDEX_POINTER), "utf8").split("\n")[0]!;
    } catch {
      name = "";
    }
    if (!INDEX_NAME.test(name)) name = "index";
    indexNames.set(shadow, name);
  }
  return name;
}

function gitEnv(shadow: string, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Git honours redirection env beyond GIT_DIR (GIT_COMMON_DIR, GIT_CONFIG_KEY_*), so the whole GIT_ namespace is cleared.
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  env.GIT_DIR = join(shadow, ".git");
  env.GIT_WORK_TREE = resolve(cwd);
  env.GIT_INDEX_FILE = join(shadow, ".git", indexName(shadow));
  env.GIT_CONFIG_GLOBAL = join(shadow, "gitconfig");
  env.GIT_CONFIG_SYSTEM = join(shadow, "gitconfig_empty");
  env.GIT_AUTHOR_NAME = "OpenMausBot Checkpoint";
  env.GIT_AUTHOR_EMAIL = "checkpoint@openmausbot.local";
  env.GIT_COMMITTER_NAME = "OpenMausBot Checkpoint";
  env.GIT_COMMITTER_EMAIL = "checkpoint@openmausbot.local";
  return env;
}

/** A timeout reports a killed child; a `signal` cancellation also stops the child, and is told apart by the signal. */
function gitFailure(command: string, err: Error & { killed?: boolean }, stderr: string, signal?: AbortSignal): Error {
  if (err.killed && err.name !== "AbortError" && !signal?.aborted) {
    return new GitTimeoutError(`git ${command} timed out after ${GIT_TIMEOUT_MS / 1000} s`);
  }
  return new Error(`git ${command}: ${(stderr || err.message).trim().slice(0, 400)}`);
}

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, input?: string): Promise<string> {
  return checkpointGitSlots.run(() => startGit(args, cwd, env, signal, input), { signal });
}

function startGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, input?: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    signal?.throwIfAborted();
    // Its own group: a timeout or a stop also ends what git started (hooks are off, but pack and gc helpers run).
    const child = execFileInGroup(
      "git",
      args,
      { cwd, env, signal, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) rejectPromise(gitFailure(args[0]!, err, stderr, signal));
        else resolvePromise(stdout);
      },
    );
    if (input !== undefined) {
      // A git that exits before reading stdin must not surface as an unhandled EPIPE.
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    }
  });
}

// One operation at a time per shadow repo (git's index lock would fail the loser); the stored tail never rejects.
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

// A pin keeps a running turn's pre-turn commit reachable until release(): a collection after a sibling's snapshot would discard it.
const LIVE_REFS = "refs/omb-live/";
function liveRef(pin: string): string {
  return LIVE_REFS + createHash("sha256").update(pin).digest("hex").slice(0, 16);
}

/** The pins this process took and has not released, per shadow. */
const heldPins = new Map<string, Set<string>>();

/** The shadows this process has taken over from the one before it: once each, or it would sweep its own turns' pins. */
const takenOver = new Set<string>();

/** The shadows whose leftover locks were looked for, since the start or since their last failure. */
const locksCleared = new Set<string>();

/** Git holds each of these for one ref or config write, a few milliseconds: one this old has no git behind it. The index
 * lock is not among them, because a git reading a big folder holds that one for as long as it reads. */
const STALE_LOCK_MS = 5_000;
const SHORT_LOCKS = ["HEAD.lock", "packed-refs.lock", "config.lock", "gc.pid.lock", join("refs", "heads", "main.lock")];

/** Windows ends a stopped git with no chance to clean up, and a crash does the same anywhere: the lock it held would fail
 * every later snapshot. A lock younger than `staleMs` is waited for until it goes or reaches that age. Zero only where
 * every git this process started on the shadow has ended: its own gits run one at a time there. */
async function clearStaleLocks(shadow: string, staleMs = STALE_LOCK_MS): Promise<void> {
  if (staleMs > 0 && locksCleared.has(shadow)) return;
  const dir = join(shadow, ".git");
  const pins = await readdir(join(dir, LIVE_REFS)).then((names) => names.filter((name) => name.endsWith(".lock")).map((name) => join(LIVE_REFS, name)), () => []);
  for (const name of [...SHORT_LOCKS, ...pins]) {
    const path = join(dir, name);
    for (let stat = statSync(path, { throwIfNoEntry: false }); stat; stat = statSync(path, { throwIfNoEntry: false })) {
      const age = Date.now() - stat.mtimeMs;
      if (age < 0 || age >= staleMs) {
        rmSync(path, { force: true });
        break;
      }
      await sleep(Math.min(250, staleMs - age));
    }
  }
  locksCleared.add(shadow);
}

/** While a collection runs, the second it prunes up to. A collection outlives a server that dies, and what the next
 * server writes must be newer than that second, or the collection would prune it as it is written. */
const COLLECTING = "omb-collecting";

async function outlastCollection(shadow: string): Promise<void> {
  const marker = join(shadow, ".git", COLLECTING);
  let until: number;
  try {
    until = Number(readFileSync(marker, "utf8"));
  } catch {
    return;
  }
  const now = () => Math.floor(Date.now() / 1000);
  // A second from a clock since set back is not waited for.
  if (Number.isSafeInteger(until) && until - now() <= 2) while (now() <= until) await sleep(100);
  rmSync(marker, { force: true });
}

/** A shadow is made beside its place and moved there whole, so nothing that stops this process part-way leaves a shadow
 * git cannot open. Takes no stop signal, for the same reason. */
async function makeShadow(shadow: string, cwd: string): Promise<void> {
  if (existsSync(join(shadow, ".git", "HEAD"))) return;
  const draft = `${shadow}.${process.pid}.new`;
  for (const stale of [draft, shadow]) rmSync(stale, { recursive: true, force: true });
  mkdirSync(draft, { recursive: true, mode: 0o700 });
  writeFileSync(join(draft, "gitconfig"), GITCONFIG, { mode: 0o600 });
  writeFileSync(join(draft, "gitconfig_empty"), "", { mode: 0o600 });
  const env = gitEnv(draft, cwd);
  // --template= keeps the user's init.templateDir hooks/config out
  await runGit(["init", "--initial-branch=main", "--template="], cwd, env);
  await runGit(["commit", "--no-verify", "--allow-empty", "-m", "checkpoint base"], cwd, env);
  renameSync(draft, shadow);
}

// Pins outlive a crashed process, so the first use of a shadow in this process drops every leftover pin.
const droppedPins = new Set<string>();
async function sweepLiveRefs(cwd: string, env: NodeJS.ProcessEnv, shadow: string): Promise<void> {
  const stale = (await runGit(["for-each-ref", "--format=%(refname)", LIVE_REFS], cwd, env)).split("\n").filter(Boolean);
  for (const ref of stale) await runGit(["update-ref", "-d", ref], cwd, env);
  if (stale.length > 0) droppedPins.add(shadow);
}

/** A shadow's first use in this process, whole or not at all: nothing here is stopped part-way by a turn's or a
 * read-ahead's signal. */
async function takeOver(shadow: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (takenOver.has(shadow)) return;
  mkdirSync(dirname(shadow), { recursive: true, mode: 0o700 });
  await makeShadow(shadow, cwd);
  writeFileSync(join(shadow, "gitconfig"), GITCONFIG, { mode: 0o600 });
  writeFileSync(join(shadow, "gitconfig_empty"), "", { mode: 0o600 });
  await outlastCollection(shadow);
  await clearStaleLocks(shadow);
  leaveLockedIndex(shadow, env);
  dropAbandonedIndex(shadow);
  await sweepLiveRefs(cwd, env, shadow);
  takenOver.add(shadow);
}

/** A lock on the index at a shadow's first use belongs to a git this process never started: one cut off with the last
 * process, or one still running after it. That index is no longer this process's to write, so the shadow moves to a copy
 * under a new name, which no other git knows. */
function leaveLockedIndex(shadow: string, env: NodeJS.ProcessEnv): void {
  const dir = join(shadow, ".git");
  const current = indexName(shadow);
  if (!existsSync(join(dir, `${current}.lock`))) return;
  const next = `index-${Date.now().toString(36)}`;
  let before = "";
  try {
    before = readFileSync(join(dir, INDEX_POINTER), "utf8").split("\n")[1] ?? "";
  } catch {
  }
  if (INDEX_NAME.test(before) && before !== "index") for (const name of [before, `${before}.lock`]) rmSync(join(dir, name), { force: true });
  try {
    copyFileSync(join(dir, current), join(dir, next));
  } catch {
  }
  writeFileSync(join(dir, INDEX_POINTER), `${next}\n${current}\n`, { mode: 0o600 });
  indexNames.set(shadow, next);
  env.GIT_INDEX_FILE = join(dir, next);
}

/** The index a shadow moved away from names objects nothing keeps any more, which git's own checks of the shadow would
 * report. No git of this process reads it; a git still running from before may put it back once, for the next start. */
function dropAbandonedIndex(shadow: string): void {
  try {
    const [current, before = ""] = readFileSync(join(shadow, ".git", INDEX_POINTER), "utf8").split("\n");
    if (INDEX_NAME.test(before) && before !== current) rmSync(join(shadow, ".git", before), { force: true });
  } catch {
  }
}

/** After a git of this process was stopped in a way that let it clean nothing up (Windows ends the whole tree at once).
 * Only where no git of this process is running on the shadow. */
function dropIndexLock(env: NodeJS.ProcessEnv): void {
  try {
    rmSync(`${env.GIT_INDEX_FILE}.lock`, { force: true });
  } catch {
  }
}

/** `base`: the empty marker HEAD was made on, or null for legacy multi-commit history the next snapshot compacts. */
type Head = { hash: string; tree: string; base: string | null };

async function readHead(cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Head> {
  const out = await runGit(["log", "-2", "--format=%H %T %P", "HEAD"], cwd, env, signal);
  const [head, parent] = out.split("\n").filter(Boolean).map((line) => line.trim().split(" "));
  const [hash, tree, ...parents] = head ?? [];
  if (!hash || !tree) throw new Error(`git log: unexpected output ${JSON.stringify(out.slice(0, 200))}`);
  let base: string | null = null;
  if (parents.length === 0) base = hash;
  else if (parents.length === 1 && parent?.length === 2) base = parents[0]!;
  return { hash, tree, base };
}

/** The empty commit every snapshot is made on. */
async function baseHead(cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Head> {
  await runGit(["commit", "--no-verify", "--allow-empty", "-m", "checkpoint base"], cwd, env, signal);
  return readHead(cwd, env, signal);
}

const CACHE_TAG = "CACHEDIR.TAG";
const TAG_LISTING = ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", `**/${CACHE_TAG}`];
const STAGED_LISTING = ["ls-files", "--stage", "-z"];
const IGNORED_LISTING = ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"];

/** Cargo and other tools put caches outside target/ or build/; honour the standard CACHEDIR.TAG. */
function cacheTagged(cwd: string, directory: string): boolean {
  try {
    const path = join(cwd, directory, CACHE_TAG);
    const stat = lstatSync(path);
    return stat.isFile() && stat.size <= 4096 && readFileSync(path, "utf8").startsWith("Signature: 8a477f597d28d172789f06886806bc55");
  } catch {
    return false;
  }
}

function cacheDirsIn(cwd: string, listing: string): string[] {
  const dirs = new Set<string>();
  for (const tag of listing.split("\0")) {
    if (!tag.includes("/") || /[\r\n]/.test(tag)) continue;
    const directory = tag.slice(0, -CACHE_TAG.length);
    if (cacheTagged(cwd, directory)) dirs.add(directory);
  }
  return [...dirs].sort();
}

function excludeFile(shadow: string): string {
  return join(shadow, ".git", "info", "exclude");
}

/** The exclude file with only the fixed list, the scan under it, then the file with what the scan found. */
async function scanCacheDirs(cwd: string, env: NodeJS.ProcessEnv, shadow: string, signal?: AbortSignal): Promise<string[]> {
  writeFileSync(excludeFile(shadow), EXCLUDES);
  const dirs = cacheDirsIn(cwd, await runGit(TAG_LISTING, cwd, env, signal));
  writeFileSync(excludeFile(shadow), EXCLUDES + dirs.map((directory) => "/" + directory.replace(/[\\*?[\]#! ]/g, "\\$&")).join("\n") + "\n");
  return dirs;
}

/** The cache directories the shadow's exclude file names, once this process has written it. */
const excludedCacheDirs = new Map<string, readonly string[]>();

/** What a capture reads before it stages: HEAD, and the index's paths (`staged`) and its ignored ones (`ignored`), each null
 * when it could not be listed. */
type Prepared = { head: Head; staged: string | null; ignored: string | null };

/** The first use in a process writes the shadow's exclude file, so a new exclude list reaches existing shadows.
 * Later uses find the exclude file naming the cache directories of the pass before, so the listings that read it run
 * beside the scan that checks it, and run again only when the scan disagrees. */
async function prepare(cwd: string, env: NodeJS.ProcessEnv, shadow: string, signal?: AbortSignal): Promise<Prepared> {
  signal?.throwIfAborted();
  await takeOver(shadow, cwd, env);
  await clearStaleLocks(shadow);
  signal?.throwIfAborted();
  env.GIT_INDEX_FILE = join(shadow, ".git", indexName(shadow));
  const list = (args: string[]) => runGit(args, cwd, env, signal).catch((e: unknown) => {
    if (e instanceof GitTimeoutError || signal?.aborted) throw e;
    return null;
  });
  const known = excludedCacheDirs.get(shadow);
  if (known !== undefined) {
    const [tags, read, staged, ignored] = await Promise.all([runGit(TAG_LISTING, cwd, env, signal), readHead(cwd, env, signal).catch(() => null), list(STAGED_LISTING), list(IGNORED_LISTING)]);
    const head = read ?? (await baseHead(cwd, env, signal));
    // The scan skips what the file already excludes, so those are checked where they stand.
    const dirs = [...new Set([...cacheDirsIn(cwd, tags), ...known.filter((directory) => cacheTagged(cwd, directory))])].sort();
    if (dirs.length === known.length && dirs.every((directory, at) => directory === known[at])) return { head, staged, ignored };
    excludedCacheDirs.delete(shadow);
    excludedCacheDirs.set(shadow, await scanCacheDirs(cwd, env, shadow, signal));
    return { head, staged, ignored: await list(IGNORED_LISTING) };
  }
  mkdirSync(join(shadow, ".git", "info"), { recursive: true });
  const headRead = readHead(cwd, env, signal).catch(() => null);
  const dirs = await scanCacheDirs(cwd, env, shadow, signal);
  const head = (await headRead) ?? (await baseHead(cwd, env, signal));
  const [staged, ignored] = await Promise.all([list(STAGED_LISTING), list(IGNORED_LISTING)]);
  excludedCacheDirs.set(shadow, dirs);
  return { head, staged, ignored };
}

type FolderNames = { exact: Set<string>; folded: Set<string> };

/** Folder listings in flight at once (libuv's pool has four threads). */
const LISTING_CONCURRENCY = 4;

/** On case-insensitive file systems git sets core.ignorecase, so an incremental `add -A` keeps a case-renamed path's old
 * spelling forever. Names compare in NFC: git stores precomposed paths on macOS, readdir returns them as created. */
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
        listings.set(dir, null);
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
    else if (!names.exact.has(name)) verdict = names.folded.has(name.toLowerCase());
    else verdict = parent !== "" && renamed(parent, true);
    if (isFolder) folders.set(path, verdict);
    return verdict;
  };
  return paths.some((path) => renamed(path, false));
}

/** Would an incremental `git add -A` differ from a rebuilt index? Only when a tracked path became ignored or cache-tagged,
 * a folder became or stopped being a nested repository, or a path was renamed by case only. */
async function indexNeedsRebuild(cwd: string, { staged, ignored }: Prepared): Promise<boolean> {
  if (ignored === null || ignored.length > 0 || staged === null) return true;
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

/** A folder no snapshot has been made of is read whole, so its files go into one pack as they are read, not into an object
 * file each: about twice as fast, and nothing left over to collect. Not for an index rebuilt over objects the shadow
 * already holds: git compresses a file into the pack before it finds the object is there. */
const WHOLE_PROJECT = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bigFileThreshold", GIT_CONFIG_VALUE_0: "1" };

async function stageWorkTree(cwd: string, env: NodeJS.ProcessEnv, prepared: Prepared, signal?: AbortSignal): Promise<void> {
  const rebuild = await indexNeedsRebuild(cwd, prepared);
  if (rebuild) await runGit(["read-tree", "--empty"], cwd, env, signal);
  const unread = prepared.staged === "" && prepared.head.hash === prepared.head.base;
  await runGit(["add", "-A", "--ignore-errors", "."], cwd, unread ? { ...env, ...WHOLE_PROJECT } : env, signal);
}

/** The checksum git ends its index file with: equal checksums are the same index, so the same tree. Null when there is none. */
function indexChecksum(env: NodeJS.ProcessEnv): string | null {
  let file: number | undefined;
  try {
    file = openSync(env.GIT_INDEX_FILE!, "r");
    const size = fstatSync(file).size;
    const end = Buffer.alloc(20);
    if (size < 32 || readSync(file, end, 0, 20, size - 20) !== 20 || end.every((byte) => byte === 0)) return null;
    return end.toString("hex");
  } catch {
    return null;
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

/** An index can name an object the shadow has lost (a collection of an earlier version, still running after its server,
 * prunes what the next server stages). Read from nothing, the folder's files are all written again. */
async function writeTree(cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  try {
    return (await runGit(["write-tree"], cwd, env, signal)).trim();
  } catch (e) {
    if (e instanceof GitTimeoutError || signal?.aborted) throw e;
    await runGit(["read-tree", "--empty"], cwd, env, signal);
    await runGit(["add", "-A", "--ignore-errors", "."], cwd, env, signal);
    return (await runGit(["write-tree"], cwd, env, signal)).trim();
  }
}

/** The index as the last finished snapshot left it, and that snapshot's tree. */
const snapshotIndex = new Map<string, { checksum: string; tree: string }>();

type CommitResult = { hash: string; advanced: boolean; compacted: boolean };

/** A partial capture never replaces the last usable checkpoint. With `pin`, the pin goes on the commit HEAD names while the
 * folder is staged, and moves with HEAD in one ref transaction when the folder had changed. */
async function commitAll(cwd: string, env: NodeJS.ProcessEnv, shadow: string, prepared: Prepared, label: string, pin?: string, signal?: AbortSignal): Promise<CommitResult | null> {
  const { head } = prepared;
  const early = pin !== undefined && head.base !== null;
  const pinned = early ? runGit(["update-ref", liveRef(pin), head.hash], cwd, env).then(() => null, (e: unknown) => e) : null;
  const unpin = async () => {
    if (early && (await pinned) === null) await runGit(["update-ref", "-d", liveRef(pin)], cwd, env).catch(() => {});
  };
  try {
    await stageWorkTree(cwd, env, prepared, signal);
  } catch (e) {
    await unpin();
    dropIndexLock(env);
    if (e instanceof GitTimeoutError) throw e;
    return null;
  }
  try {
    const pinFailure = await pinned;
    if (pinFailure) throw pinFailure;
    const staged = indexChecksum(env);
    const last = snapshotIndex.get(shadow);
    const tree = staged !== null && last?.checksum === staged ? last.tree : await writeTree(cwd, env, signal);
    const changed = tree !== head.tree;
    let hash = head.hash;
    if (changed || head.base === null) {
      const base = head.base ?? (await runGit(["rev-list", "--max-parents=0", "HEAD"], cwd, env, signal)).trim();
      const message = changed ? label : (await runGit(["show", "-s", "--format=%B", "HEAD"], cwd, env, signal)).trim();
      // Parent only the empty marker: keeping the previous commit as an ancestor would retain every old tree.
      hash = (await runGit(["commit-tree", tree, "-p", base, "-m", message], cwd, env, signal)).trim();
    }
    const advanced = hash !== head.hash;
    const updates = [advanced ? `update HEAD ${hash} ${head.hash}\n` : "", pin && (advanced || !early) ? `update ${liveRef(pin)} ${hash}\n` : ""].join("");
    if (updates !== "") await runGit(["update-ref", "--stdin"], cwd, env, signal, updates);
    // write-tree may have rewritten the index, so its checksum is read again.
    const checksum = indexChecksum(env);
    if (checksum === null) snapshotIndex.delete(shadow);
    else snapshotIndex.set(shadow, { checksum, tree });
    return { hash, advanced, compacted: advanced && head.base === null };
  } catch (e) {
    await unpin();
    throw e;
  }
}

const commitsSinceGc = new Map<string, number>();

/** Packs grow between collections because `git add` writes files over core.bigFileThreshold straight into packs. */
const packBaselineKib = new Map<string, number>();

/** A collection that failed by itself (not stopped to make way): owed, with how many failed in a row. The next snapshot
 * that adds a commit queues it again, after 1, 2, 4… up to GC_EVERY_COMMITS commits, so one that keeps failing costs
 * a try now and then, never one per turn. A collection decided due resets the counts above; this keeps it owed. */
const owedCollections = new Map<string, number>();

/** The pack baseline a due collection set aside, put back when that collection fails. */
const baselineBeforeCollection = new Map<string, number | undefined>();

/** Held until that turn's settled diff is queued or its pin is released, whichever comes first. */
const pendingCollections = new Map<string, (stop: AbortController) => Promise<void>>();

/** A collection waiting its turn in the folder's queue or running; a snapshot or a settled diff stops it. */
const collecting = new Map<string, AbortController>();

/** Queued behind the folder's operations: runs what a snapshot has held by then. */
function releaseCollection(shadow: string): void {
  if (collecting.get(shadow)?.signal.aborted === false) return;
  const stop = new AbortController();
  collecting.set(shadow, stop);
  void serialize(shadow, async () => {
    const collect = pendingCollections.get(shadow);
    try {
      if (collect === undefined || stop.signal.aborted) return;
      pendingCollections.delete(shadow);
      await collect(stop);
    } finally {
      if (collecting.get(shadow) === stop) collecting.delete(shadow);
    }
  }).catch(() => {});
}

/** Nobody's message or digest waits for a collection: one queued or running makes way, and is held again. */
function yieldCollection(shadow: string): void {
  collecting.get(shadow)?.abort();
}

async function collectionDue(shadow: string, result: CommitResult, cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const freed = droppedPins.delete(shadow) || result.compacted;
  if (!result.advanced && !freed) return false;
  const commits = (commitsSinceGc.get(shadow) ?? 0) + (result.advanced ? 1 : 0);
  commitsSinceGc.set(shadow, commits);
  const failed = owedCollections.get(shadow);
  const owed = failed !== undefined && commits >= Math.min(GC_EVERY_COMMITS, 2 ** (failed - 1));
  let due = freed || owed || commits >= GC_EVERY_COMMITS;
  if (!due) {
    const counted = await runGit(["count-objects", "-v"], cwd, env).catch(() => "");
    if (counted !== "") {
      const field = (name: string) => Number(new RegExp(`^${name}: (\\d+)$`, "m").exec(counted)?.[1] ?? 0);
      const pack = field("size-pack");
      if (!packBaselineKib.has(shadow)) packBaselineKib.set(shadow, pack);
      const newData = field("size") + Math.max(0, pack - packBaselineKib.get(shadow)!);
      due = field("count") >= GC_LOOSE_OBJECTS || newData >= GC_NEW_DATA_KIB;
    }
  }
  if (due) {
    commitsSinceGc.set(shadow, 0);
    if (!baselineBeforeCollection.has(shadow)) baselineBeforeCollection.set(shadow, packBaselineKib.get(shadow));
    packBaselineKib.delete(shadow);
  }
  return due;
}

/** Prunes what was unreachable when it started and nothing newer: a collection this process no longer waits for (it died,
 * or was restarted) can then never prune what a later git is writing. Windows ends a stopped git by force, with its locks
 * left in place, so there a collection that has started runs to its end and the turn waits for it. */
async function collectObsolete(shadow: string, cwd: string, env: NodeJS.ProcessEnv, stop: AbortController): Promise<void> {
  const signal = process.platform === "win32" ? undefined : stop.signal;
  const marker = join(shadow, ".git", COLLECTING);
  const before = Math.floor(Date.now() / 1000);
  const collect = async () => {
    await runGit(["reflog", "expire", "--expire=now", "--all"], cwd, env, signal);
    stop.signal.throwIfAborted();
    await runGit(["gc", `--prune=${before}`, "--quiet"], cwd, env, signal);
  };
  try {
    writeFileSync(marker, String(before), { mode: 0o600 });
    // Once more, without whatever lock a git stopped by force left behind; a git that ran out of time is not tried again.
    await collect().catch(async (e: unknown) => {
      if (e instanceof GitTimeoutError || stop.signal.aborted) throw e;
      await clearStaleLocks(shadow, 0);
      stop.signal.throwIfAborted();
      await collect();
    });
    owedCollections.delete(shadow);
    baselineBeforeCollection.delete(shadow);
  } catch (e) {
    if (stop.signal.aborted) {
      if (!pendingCollections.has(shadow)) pendingCollections.set(shadow, (again) => collectObsolete(shadow, cwd, env, again));
      return;
    }
    // Still owed: a later snapshot queues it again, and the growth it was due for still counts.
    owedCollections.set(shadow, (owedCollections.get(shadow) ?? 0) + 1);
    const baseline = baselineBeforeCollection.get(shadow);
    baselineBeforeCollection.delete(shadow);
    if (baseline !== undefined && !packBaselineKib.has(shadow)) packBaselineKib.set(shadow, baseline);
    console.warn(`checkpoint cleanup deferred; the latest snapshot is preserved: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rmSync(marker, { force: true });
  }
}

function usableFolder(botId: string, cwd: string): { worktree: string; shadow: string } | null {
  if (refusalReason(cwd) !== null) return null;
  const folder = folderShadow(botId, cwd);
  return folder === null || disabledFolders.has(folder.shadow) ? null : folder;
}

/** Never throws. With `pin`, the commit stays reachable through later snapshots until release(pin). */
export async function snapshot(botId: string, cwd: string, label: string, signal?: AbortSignal, opts?: { pin?: string }): Promise<string | null> {
  if (signal?.aborted) return null;
  if (!(await gitAvailable())) return null;
  const folder = usableFolder(botId, cwd);
  if (folder === null) return null;
  const { worktree, shadow } = folder;
  try {
    yieldCollection(shadow);
    const env = gitEnv(shadow, worktree);
    const hash = await serialize(shadow, async () => {
      // A read-ahead this snapshot waited behind may have found the folder too big: the turn takes that answer.
      if (disabledFolders.has(shadow)) return null;
      const capture = async () => commitAll(worktree, env, shadow, await prepare(worktree, env, shadow, signal), label, opts?.pin, signal);
      const result = await capture().catch(async (e: unknown) => {
        if (e instanceof GitTimeoutError || signal?.aborted) throw e;
        // Once more, without whatever lock a git stopped by force left behind.
        await clearStaleLocks(shadow, 0);
        return capture();
      });
      if (!result) return null;
      // Counted behind this snapshot, off the turn's path, and held for the turn's settled diff: GC never eats into the digest's capture window.
      void serialize(shadow, async () => {
        if (await collectionDue(shadow, result, worktree, env)) pendingCollections.set(shadow, (stop) => collectObsolete(shadow, worktree, env, stop));
      }).catch(() => {});
      return result.hash;
    });
    if (hash !== null) failedInARow.delete(shadow);
    if (hash !== null && opts?.pin !== undefined) heldPins.set(shadow, (heldPins.get(shadow) ?? new Set()).add(opts.pin));
    return hash;
  } catch (e) {
    if (signal?.aborted) return null;
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof GitTimeoutError) disableFolder(shadow, botId, worktree, message);
    else snapshotFailed(shadow, botId, worktree, message);
    return null;
  }
}

/** Ahead of a turn: reads the folder into the shadow's index, so the turn's own snapshot finds its files already read.
 * Moves no ref, so the last snapshot stays the newest. Never throws; only a timeout changes anything for later snapshots. */
export async function prime(botId: string, cwd: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted || !(await gitAvailable())) return false;
  const folder = usableFolder(botId, cwd);
  if (folder === null) return false;
  const { worktree, shadow } = folder;
  const env = gitEnv(shadow, worktree);
  return serialize(shadow, async () => {
    try {
      await stageWorkTree(worktree, env, await prepare(worktree, env, shadow, signal), signal);
      await runGit(["write-tree"], worktree, env, signal);
      return true;
    } catch (e) {
      dropIndexLock(env);
      // Too big to read in the time a turn would give it: the turn must not wait that long again.
      if (e instanceof GitTimeoutError && !signal?.aborted) disableFolder(shadow, botId, worktree, e.message);
      return false;
    }
  });
}

/** Resolves once no git of this process is running or waiting on any of the bot's shadows: its folder can then be removed.
 * A collection queued or running there is stopped first. */
export async function quiet(botId: string): Promise<void> {
  const mine = (shadow: string) => shadow.startsWith(join(CHECKPOINTS_DIR, botId) + sep);
  for (const [shadow, stop] of collecting) if (mine(shadow)) stop.abort();
  await Promise.all([...chains].filter(([shadow]) => mine(shadow)).map(([, tail]) => tail));
}

/** At shutdown: no collection is left running behind the server. */
export function stopCollections(): void {
  for (const stop of collecting.values()) stop.abort();
}

/** Queued behind the shadow's pending operations, so a diff already queued still finds its commit. */
export async function release(botId: string, cwd: string, pin: string): Promise<void> {
  if (!(await gitAvailable())) return;
  try {
    const worktree = realpathSync(resolve(cwd));
    const shadow = shadowDir(botId, worktree);
    if (!existsSync(join(shadow, ".git", "HEAD"))) return;
    const env = gitEnv(shadow, worktree);
    const held = heldPins.get(shadow)?.delete(pin) ?? false;
    await serialize(shadow, async () => {
      const unpin = () => runGit(["update-ref", "-d", liveRef(pin)], worktree, env);
      await unpin().catch(async () => {
        await clearStaleLocks(shadow, 0);
        await unpin();
      });
    });
    // A turn that ended without a settled diff: the collection its snapshot held runs now.
    if (held) releaseCollection(shadow);
  } catch (e) {
    console.warn(`checkpoint pin not released for bot ${botId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface CheckpointDiff {
  changed: string[];
  added: string[];
  deleted: string[];
}

export async function diffWorkingTree(botId: string, cwd: string, fromHash: string, signal?: AbortSignal): Promise<CheckpointDiff | null> {
  if (signal?.aborted || !COMMIT_HASH.test(fromHash)) return null;
  if (!(await gitAvailable())) return null;
  const folder = usableFolder(botId, cwd);
  if (folder === null) return null;
  const { worktree, shadow } = folder;
  try {
    yieldCollection(shadow);
    const env = gitEnv(shadow, worktree);
    const run = serialize(shadow, async () => {
      try {
        await stageWorkTree(worktree, env, await prepare(worktree, env, shadow, signal), signal);
      } catch (e) {
        dropIndexLock(env);
        throw e;
      }
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
    // The collection this turn's snapshot left pending runs behind this diff.
    releaseCollection(shadow);
    return await run;
  } catch (e) {
    if (e instanceof GitTimeoutError && !signal?.aborted) disableFolder(shadow, botId, worktree, e.message);
    return null;
  }
}
