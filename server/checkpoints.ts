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
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";

import { DATA_DIR } from "./config.ts";

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

const disabledBots = new Set<string>();

function disable(botId: string, message: string): void {
  disabledBots.add(botId);
  console.warn(`workspace checkpoints disabled for bot ${botId} this session: ${message}`);
}

class GitTimeoutError extends Error {}

const disabledFolders = new Set<string>();

function disableFolder(shadow: string, botId: string, worktree: string, message: string): void {
  if (disabledFolders.has(shadow)) return;
  disabledFolders.add(shadow);
  console.warn(`workspace checkpoints disabled for bot ${botId} in ${worktree} this session: ${message}`);
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

function gitEnv(shadow: string, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Git honours redirection env beyond GIT_DIR (GIT_COMMON_DIR, GIT_CONFIG_KEY_*), so the whole GIT_ namespace is cleared.
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

/** execFile reports its own timeout as a killed child; a `signal` cancellation arrives as an AbortError instead. */
function gitFailure(command: string, err: Error & { killed?: boolean }, stderr: string, signal?: AbortSignal): Error {
  if (err.killed && err.name !== "AbortError" && !signal?.aborted) {
    return new GitTimeoutError(`git ${command} timed out after ${GIT_TIMEOUT_MS / 1000} s`);
  }
  return new Error(`git ${command}: ${(stderr || err.message).trim().slice(0, 400)}`);
}

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, input?: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    signal?.throwIfAborted();
    const child = execFile(
      "git",
      args,
      { cwd, env, signal, windowsHide: true, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
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

// Pins outlive a crashed process, so the first use of a shadow in this process drops every leftover pin.
const sweptShadows = new Set<string>();
const droppedPins = new Set<string>();
async function sweepLiveRefs(cwd: string, env: NodeJS.ProcessEnv, shadow: string, signal?: AbortSignal): Promise<void> {
  if (sweptShadows.has(shadow)) return;
  const stale = (await runGit(["for-each-ref", "--format=%(refname)", LIVE_REFS], cwd, env, signal)).split("\n").filter(Boolean);
  for (const ref of stale) await runGit(["update-ref", "-d", ref], cwd, env, signal);
  if (stale.length > 0) droppedPins.add(shadow);
  sweptShadows.add(shadow);
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

/** Rewrites its config files on every use so exclude-list updates reach existing shadows. */
async function ensureShadow(cwd: string, env: NodeJS.ProcessEnv, shadow: string, signal?: AbortSignal): Promise<Head> {
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
  // Cargo and other tools put caches outside target/ or build/; honour the standard CACHEDIR.TAG.
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
    }
  }
  writeFileSync(join(shadow, ".git", "info", "exclude"), EXCLUDES + [...cachePatterns].join("\n") + "\n");
  let head: Head;
  try {
    head = await readHead(cwd, env, signal);
  } catch {
    await runGit(["commit", "--no-verify", "--allow-empty", "-m", "checkpoint base"], cwd, env, signal);
    head = await readHead(cwd, env, signal);
  }
  await sweepLiveRefs(cwd, env, shadow, signal);
  return head;
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
async function indexNeedsRebuild(cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean> {
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

async function stageWorkTree(cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (await indexNeedsRebuild(cwd, env, signal)) await runGit(["read-tree", "--empty"], cwd, env, signal);
  await runGit(["add", "-A", "--ignore-errors", "."], cwd, env, signal);
}

type CommitResult = { hash: string; advanced: boolean; compacted: boolean };

/** A partial capture never replaces the last usable checkpoint; with `pin`, the pin lands in the ref transaction that moves HEAD. */
async function commitAll(cwd: string, env: NodeJS.ProcessEnv, head: Head, label: string, pin?: string, signal?: AbortSignal): Promise<CommitResult | null> {
  try {
    await stageWorkTree(cwd, env, signal);
  } catch (e) {
    if (e instanceof GitTimeoutError) throw e;
    return null;
  }
  const tree = (await runGit(["write-tree"], cwd, env, signal)).trim();
  const changed = tree !== head.tree;
  let hash = head.hash;
  if (changed || head.base === null) {
    const base = head.base ?? (await runGit(["rev-list", "--max-parents=0", "HEAD"], cwd, env, signal)).trim();
    const message = changed ? label : (await runGit(["show", "-s", "--format=%B", "HEAD"], cwd, env, signal)).trim();
    // Parent only the empty marker: keeping the previous commit as an ancestor would retain every old tree.
    hash = (await runGit(["commit-tree", tree, "-p", base, "-m", message], cwd, env, signal)).trim();
  }
  const advanced = hash !== head.hash;
  const updates = [advanced ? `update HEAD ${hash} ${head.hash}\n` : "", pin ? `update ${liveRef(pin)} ${hash}\n` : ""].join("");
  if (updates !== "") await runGit(["update-ref", "--stdin"], cwd, env, signal, updates);
  return { hash, advanced, compacted: advanced && head.base === null };
}

const commitsSinceGc = new Map<string, number>();

/** Packs grow between collections because `git add` writes files over core.bigFileThreshold straight into packs. */
const packBaselineKib = new Map<string, number>();

/** Held until that turn's settled diff is queued, or until the next snapshot, which runs it first. */
const pendingCollections = new Map<string, () => Promise<void>>();

function releaseCollection(shadow: string): void {
  const collect = pendingCollections.get(shadow);
  if (collect === undefined) return;
  pendingCollections.delete(shadow);
  void serialize(shadow, collect);
}

async function collectionDue(shadow: string, result: CommitResult, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean> {
  const freed = droppedPins.delete(shadow) || result.compacted;
  if (!result.advanced && !freed) return false;
  const commits = (commitsSinceGc.get(shadow) ?? 0) + (result.advanced ? 1 : 0);
  commitsSinceGc.set(shadow, commits);
  let due = freed || commits >= GC_EVERY_COMMITS;
  if (!due) {
    const counted = await runGit(["count-objects", "-v"], cwd, env, signal).catch(() => "");
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
    packBaselineKib.delete(shadow);
  }
  return due;
}

async function collectObsolete(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await runGit(["reflog", "expire", "--expire=now", "--all"], cwd, env);
    await runGit(["gc", "--prune=now", "--quiet"], cwd, env);
  } catch {
    console.warn("checkpoint cleanup deferred; the latest snapshot is preserved");
  }
}

/** Never throws. With `pin`, the commit stays reachable through later snapshots until release(pin). */
export async function snapshot(botId: string, cwd: string, label: string, signal?: AbortSignal, opts?: { pin?: string }): Promise<string | null> {
  if (signal?.aborted) return null;
  if (disabledBots.has(botId)) return null;
  if (!(await gitAvailable())) return null;
  if (refusalReason(cwd) !== null) return null;
  const folder = folderShadow(botId, cwd);
  if (folder === null || disabledFolders.has(folder.shadow)) return null;
  const { worktree, shadow } = folder;
  try {
    // Collect ahead of this snapshot, so this turn's diff never queues behind GC.
    releaseCollection(shadow);
    return await serialize(shadow, async () => {
      const env = gitEnv(shadow, worktree);
      const head = await ensureShadow(worktree, env, shadow, signal);
      const result = await commitAll(worktree, env, head, label, opts?.pin, signal);
      if (!result) return null;
      // Held for this turn's settled diff, so GC never eats into the digest's capture window.
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

/** Queued behind the shadow's pending operations, so a diff already queued still finds its commit. */
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
    // The collection this turn's snapshot left pending runs behind this diff.
    releaseCollection(shadow);
    return await run;
  } catch (e) {
    if (e instanceof GitTimeoutError && !signal?.aborted) disableFolder(shadow, botId, worktree, e.message);
    return null;
  }
}
