// What a deleted conversation or bot leaves in its folders that is nobody's work: the package installs in its
// conversation folders (task-workspaces/<bot>/<thread>: a node_modules a package manager made, a Python venv holding
// only a venv's own folders), which Files never carries and an install makes again, and the full tool results kept for
// it (tool-results/<thread>). A build's output (a Rust target folder) is not among them: it can be the program the
// person asked for, and Files brings it to them. The files the bot made for the person stay: the delete dialogs
// promise them ("Generated project files are kept"), Files lists every conversation folder that holds a file and
// brings it to the person's computer, and the bot's other conversations are told where these folders are. Event logs
// and engine sessions go with the conversation elsewhere (store.ts, delete-leftovers.ts).
//
// What counts as an install, and nothing else: a node_modules with a package manager's own marker in it and a
// package.json beside it, that git does not track; a venv (.venv or venv) with a pyvenv.cfg whose top level holds
// only a venv's own entries. Anything else, or anything that cannot be read, stays, with a line in the log.
//
// Safety: a folder is touched only when nothing that remains can use it. Its conversation is no remaining bot's or
// room's (a room's turns use a member bot's conversation folder under the room's own id); no remaining bot,
// conversation or room works in it, inside it or in a folder between it and the data folder (a fork keeps working in
// its source's folder), compared as the file system names it (case-insensitively on macOS and Windows); no link in
// the bot's other folders leads into it; no process (Linux) works in it, holds a file open or has one mapped there;
// and neither the saved definitions and instructions nor a remaining conversation's messages name it. While any of
// those cannot be read, it stays. That is checked again just before each move, and nothing moves while the server is
// frozen or a backup is under way.
// Nothing is reached through a link: every folder from the data folder down must be a real folder, and what is moved
// must be the very folder that was checked. It lands first under .removing/check-…, a name the drain never takes, is
// compared there by device and inode, and only then gets the drain's name; a mismatch is moved back, or kept under
// check-… when that fails. The drain leaves an entry a process is still in, and on Linux removes it with the system's
// GNU rm (one file system, no link followed), elsewhere with a Node walk that re-checks each folder after listing it.
// A crash leaves either the whole tree in place or a part of it in .removing, which the next start finishes. Nothing
// runs on the delete's own call: the work is queued and paced, rm runs at low priority in its own process, and the
// transcripts are read in a worker, so a tree of hundreds of thousands of files never holds a turn or the event loop.
// Wired on a Cloud home only, and only with OMB_CONVERSATION_FOLDER_CLEANUP=on (off by default).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const REMOVING_DIR = ".removing";
export const FOLDER_CLEANUP_ENV = "OMB_CONVERSATION_FOLDER_CLEANUP";

/** The delete-time cleanup, on a Cloud home with OMB_CONVERSATION_FOLDER_CLEANUP=on only (off by default, so a delete
 * behaves as before until it has been proven on a test Cloud); undefined otherwise. */
export function deleteTimeCleanup<T>(env: NodeJS.ProcessEnv, cloudHome: boolean, make: () => T): T | undefined {
  return cloudHome && env[FOLDER_CLEANUP_ENV]?.trim().toLowerCase() === "on" ? make() : undefined;
}
const ID = /^[\w-]{1,128}$/;
const RETIRED = /^\d{1,16}-[0-9a-f]{12}$/;
const MAX_DEPTH = 8;
const MAX_SCANNED = 200_000;
const MAX_LINK_SCAN = 50_000;
const MAX_HELD_FILE_BYTES = 16 * 1024 ** 2;
const MAX_GIT_INDEX_BYTES = 64 * 1024 ** 2;
const YIELD_EVERY = 256;
const PAUSE_EVERY = 4_096;
const PAUSE_MS = 20;
const DRAIN_AFTER_START_MS = 60_000;
/** A package manager's own record inside a node_modules it made (npm, pnpm, Yarn 1, Yarn 2+). */
const NODE_MARKERS = [".package-lock.json", ".modules.yaml", ".yarn-integrity", ".yarn-state.yml"];
/** What a venv made by venv, virtualenv or uv holds at its top level. */
const VENV_ENTRIES = new Set(["bin", "Scripts", "lib", "lib64", "Lib", "include", "Include", "share", "pyvenv.cfg", ".gitignore", "CACHEDIR.TAG"]);
/** Folders a link scan of the bot's other folders does not walk into: installs and history. */
const LINK_SCAN_SKIP = new Set(["node_modules", ".git", ".venv", "venv"]);

type Folder = string | null | undefined;
type TaskLike = { threadId: string; cwd?: Folder; pinnedCwd?: Folder };
/** The parts of the store's records this needs: every remaining conversation and every folder one works in. */
export interface LiveRecords {
  readonly bots: ReadonlyArray<{ id: string; threadId?: string; cwd?: Folder; tasks?: ReadonlyArray<TaskLike> }>;
  readonly groups: ReadonlyArray<{ id: string; threadId?: string; cwd?: Folder; pinnedCwd?: Folder; tasks?: ReadonlyArray<TaskLike> }>;
}

export function liveThreadIds(records: LiveRecords): Set<string> {
  const ids = new Set<string>();
  for (const owner of [...records.bots, ...records.groups]) {
    if (owner.threadId) ids.add(owner.threadId);
    for (const task of owner.tasks ?? []) ids.add(task.threadId);
  }
  return ids;
}

/** Where every remaining conversation works; `except` leaves out one conversation's own folders (an idle one whose
 * installs host/idle-reclaim.ts sheds: its own folder is not "another conversation working there"). */
export function liveFolders(records: LiveRecords, except?: string): string[] {
  const folders: Folder[] = [];
  const skip = (threadId: string | undefined) => except !== undefined && threadId === except;
  const of = (task: TaskLike) => (skip(task.threadId) ? [] : [task.cwd, task.pinnedCwd]);
  for (const bot of records.bots) folders.push(skip(bot.threadId) ? null : bot.cwd, ...(bot.tasks ?? []).flatMap(of));
  for (const group of records.groups) folders.push(...(skip(group.threadId) ? [] : [group.cwd, group.pinnedCwd]), ...(group.tasks ?? []).flatMap(of));
  return folders.filter((folder): folder is string => typeof folder === "string" && isAbsolute(folder));
}

/** The folder names a thread's full tool results are kept under: the hook's (index.ts) and the MCP gate's
 * (mcp-gate-config.ts spillDir). */
export const hookResultsName = (threadId: string) => threadId.replace(/[^\w.-]/g, "_");
export const gateResultsName = (threadId: string) => threadId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "thread";

/** Paths compared as the file system compares them: macOS's and Windows' default volumes ignore case. */
const FOLDS = process.platform === "darwin" || process.platform === "win32";
const fold = (path: string) => (FOLDS ? path.toLowerCase() : path);
export const inside = (root: string, path: string) => {
  const rel = relative(fold(root), fold(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
/** `inside` for paths already absolute and normalized (resolve, realpath): a string compare, for the checks that run
 * over every live folder. */
const within = (root: string, path: string) => {
  const a = fold(root), b = fold(path);
  return a === b || b.startsWith(a.endsWith(sep) ? a : a + sep);
};
function real(path: string): string | null {
  try { return realpathSync.native(path); } catch { return null; }
}
function realFolder(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

/** Whether `path` is strictly inside `root`, `root` is inside `dataDir`, every folder from `dataDir` down to `path`
 * (itself included) is a real folder, not a link, and where `path` really is stays inside where `dataDir` really is. */
export function plainFolderUnder(dataDir: string, root: string, path: string): boolean {
  if (!inside(dataDir, root) || !inside(root, path) || fold(resolve(path)) === fold(resolve(root))) return false;
  let at = resolve(dataDir);
  for (const part of relative(resolve(dataDir), resolve(path)).split(sep)) {
    if (!part || part === "..") return false;
    at = join(at, part);
    if (!realFolder(at)) return false;
  }
  const realData = real(dataDir), realPath = real(path);
  return Boolean(realData && realPath && inside(realData, realPath));
}

/** The ways a text may name a conversation folder: its path with either separator, as JSON writes it, and its id. */
export function folderMentions(botId: string, threadId: string): string[] {
  return [`task-workspaces/${botId}/${threadId}`, `task-workspaces\\${botId}\\${threadId}`, `task-workspaces\\\\${botId}\\\\${threadId}`];
}

export interface FolderCleanupDeps {
  dataDir: string;
  records(): LiveRecords;
  /** What the server holds in memory that may name a path (its settings, routines, …); null while not readable yet,
   * and then every folder stays. The saved definitions and instructions on disk are read as well. */
  heldText?(): string | null;
  /** For each word, the remaining conversations whose messages hold it (transcript-mentions.ts); a rejection keeps. */
  mentions?(words: readonly string[]): Promise<Map<string, ReadonlySet<string>>>;
  /** Why nothing may move now (frozen after a move, a backup being made or restored), else null. Asked before each move
   * and before the start's leftovers are finished. */
  paused?(): string | null;
  /** Every path the processes work in, hold open or have mapped (linuxProcessPaths), or null where that cannot be read. */
  processFolders?(): Promise<readonly string[] | null>;
  /** When the start's leftover .removing is finished; false: only on request. Default: a minute after start. */
  drainAfterMs?: number | false;
  pause?(ms: number): Promise<void>;
  /** Every path this machine's processes work in, hold open or have mapped (linuxProcessPaths), or null where that
   * cannot be read; the drain leaves an entry one of them is in. */
  processPaths?(): Promise<readonly string[] | null>;
  /** The system's GNU rm, or null to walk in Node (gnuRm by default). */
  systemRm?(): Promise<string | null>;
  /** For tests: runs between the last check of a tree and its move. */
  beforeMove?(path: string): void;
  log?(line: string): void;
  warn?(line: string): void;
}

/** `name`: a folder name under tool-results, which is a thread id for a deleted conversation. */
type Job = { kind: "workspace"; folder: string } | { kind: "results"; name: string };
/** What one idle reclaim pass reads once (createConversationFolderCleanup's idlePass). */
export interface IdlePass {
  /** Opaque outside this module. */
  readonly view: unknown;
  mentioned(): Promise<ReadonlyMap<string, ReadonlySet<string>> | null>;
}
export interface CleanupTotals { folders: number; entries: number; bytes: number; failed: number }
/** An install found in a conversation folder, with the identity it had when found. */
export interface FoundTree { path: string; dev: number; ino: number }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const code = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/** Every path this machine's processes work in, hold open or have mapped, from /proc; null where that cannot be read. */
export async function linuxProcessPaths(): Promise<string[] | null> {
  if (process.platform !== "linux") return null;
  let pids: string[];
  try { pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name)); } catch { return null; }
  const paths = new Set<string>();
  for (const pid of pids) {
    try { paths.add(await readlink(`/proc/${pid}/cwd`)); } catch { /* gone, or another user's */ }
    for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
      if (target.startsWith("/")) paths.add(target.replace(/ \(deleted\)$/, ""));
    }
    const maps = await readFile(`/proc/${pid}/maps`, "utf8").catch(() => "");
    for (const line of maps.split("\n")) {
      const at = line.indexOf(" /");
      if (at > 0) paths.add(line.slice(at + 1).replace(/ \(deleted\)$/, ""));
    }
  }
  return [...paths];
}

/** The system's GNU rm (coreutils, as in the Cloud image's Debian base), found once; null elsewhere (macOS, Windows,
 * busybox), where the cleanup walks in Node instead. */
let gnuRmFound: Promise<string | null> | undefined;
export function gnuRm(): Promise<string | null> {
  return gnuRmFound ??= process.platform !== "linux" ? Promise.resolve(null) : new Promise((done) => {
    execFile("rm", ["--version"], { timeout: 10_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" } }, (error, stdout) => {
      done(!error && /GNU coreutils/.test(String(stdout)) ? "rm" : null);
    });
  });
}

/** `nice rm -rf --one-file-system -- entry`: true once the entry is gone. */
function runRm(rm: string, entry: string): Promise<boolean> {
  return new Promise((done) => {
    execFile("nice", ["-n", "19", rm, "-rf", "--one-file-system", "--", entry], { timeout: 30 * 60_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" } }, () => {
      lstat(entry).then(() => done(false), () => done(true));
    });
  });
}

/** Makes a moved tree's folders writable for its owner (GNU chmod never follows a link it meets), for rm's second go. */
function chmodTree(entry: string): Promise<void> {
  return new Promise((done) => {
    execFile("chmod", ["-R", "u+rwx", "--", entry], { timeout: 10 * 60_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" } }, () => done());
  });
}

/** Whether a git index (v2 or v3) names a file under `rel` (a path from the repository's top, `/`-separated); null when
 * that cannot be told (v4's compressed names, a split or sparse index, a large or unreadable index). */
async function gitTracks(indexFile: string, rel: string): Promise<boolean | null> {
  let data: Buffer;
  try {
    const stats = await lstat(indexFile);
    if (!stats.isFile()) return null;
    if (stats.size > MAX_GIT_INDEX_BYTES) return null;
    data = await readFile(indexFile);
  } catch (error) {
    return code(error) === "ENOENT" ? false : null;
  }
  return indexNames(data, rel);
}

/** Reads a git index's entries (v2, v3) and its extensions; see gitTracks. */
export function indexNames(data: Buffer, rel: string): boolean | null {
  if (data.length < 12 || data.toString("latin1", 0, 4) !== "DIRC") return null;
  const version = data.readUInt32BE(4);
  if (version !== 2 && version !== 3) return null;
  const count = data.readUInt32BE(8);
  const end = data.length - 20; // the trailing checksum
  let at = 12, tracked = false;
  for (let n = 0; n < count; n++) {
    if (at + 62 > end) return null;
    const flags = data.readUInt16BE(at + 60);
    const extended = version === 3 && (flags & 0x4000) !== 0;
    const nameAt = at + 62 + (extended ? 2 : 0);
    const nul = data.indexOf(0, nameAt);
    if (nul < 0 || nul > end) return null;
    const name = data.toString("utf8", nameAt, nul);
    if (name === rel || name.startsWith(`${rel}/`)) tracked = true;
    // An entry is padded with 1 to 8 NULs so its length from its start is a multiple of 8.
    at += Math.ceil((nameAt - at + (nul - nameAt) + 1) / 8) * 8;
  }
  while (at + 8 <= end) {
    const signature = data.toString("latin1", at, at + 4);
    if (signature === "link" || signature === "sdir") return null;
    at += 8 + data.readUInt32BE(at + 4);
  }
  return tracked;
}

export function createConversationFolderCleanup(deps: FolderCleanupDeps) {
  const dataDir = resolve(deps.dataDir);
  const tasksRoot = join(dataDir, "task-workspaces");
  const resultsRoot = join(dataDir, "tool-results");
  const removing = join(dataDir, REMOVING_DIR);
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const queued = new Map<string, Job>();
  let running: Promise<void> = Promise.resolve();
  let active = false;
  let steps = 0;

  async function step(): Promise<void> {
    steps++;
    if (steps % PAUSE_EVERY === 0) await pause(PAUSE_MS);
    else if (steps % YIELD_EVERY === 0) await new Promise<void>((done) => setImmediate(done));
  }

  /** One pass's view of what remains, resolved once: the live conversations and where they work, as written and as the
   * file system names them. Records are read again before each move; a folder's real path only once per pass. */
  function batchView() {
    const realOf = new Map<string, string | null>();
    const resolved = (path: string) => {
      if (!realOf.has(path)) realOf.set(path, real(path));
      return realOf.get(path) ?? null;
    };
    const now = (except?: string) => {
      const records = deps.records();
      const folders: string[] = [];
      for (const used of new Set(liveFolders(records, except))) {
        folders.push(resolve(used));
        const found = resolved(used);
        if (found) folders.push(found);
      }
      return { live: liveThreadIds(records), folders };
    };
    /** Resolves every live folder off the event loop first, a few at a time, so the checks before each move only read. */
    const warm = async () => {
      const pending = [...new Set(liveFolders(deps.records()))].filter((path) => !realOf.has(path));
      for (let at = 0; at < pending.length; at += 64) {
        await Promise.all(pending.slice(at, at + 64).map(async (path) => {
          realOf.set(path, await realpath(path).catch(() => null));
        }));
      }
      if (!realOf.has(dataDir)) realOf.set(dataDir, await realpath(dataDir).catch(() => null));
    };
    return { now, resolved, warm, links: new Map<string, Promise<Array<{ from: string; leads: string[] }> | null>>(), saved: null as Promise<string | null> | null };
  }
  type View = ReturnType<typeof batchView>;

  /** The saved definitions and instructions, which name paths in settings and prose: every JSON file at the top of the
   * data folder, each bot's SOUL.md and its memory files. Null when one cannot be read. */
  async function savedText(): Promise<string | null> {
    const parts: string[] = [];
    const take = async (path: string) => {
      const stats = await lstat(path).catch(() => null);
      if (!stats || !stats.isFile()) return true;
      if (stats.size > MAX_HELD_FILE_BYTES) return false;
      try { parts.push(await readFile(path, "utf8")); return true; } catch { return false; }
    };
    const names = async (dir: string) => (realFolder(dir) ? readdir(dir).catch(() => [] as string[]) : []);
    for (const name of await names(dataDir)) if (name.endsWith(".json") && !await take(join(dataDir, name))) return null;
    for (const bot of await names(join(dataDir, "bots"))) if (!await take(join(dataDir, "bots", bot, "SOUL.md"))) return null;
    const walk = async (dir: string, depth: number): Promise<boolean> => {
      for (const name of await names(dir)) {
        const path = join(dir, name);
        if (realFolder(path)) { if (depth < 4 && !await walk(path, depth + 1)) return false; }
        else if (name.endsWith(".md") && !await take(path)) return false;
      }
      return true;
    };
    for (const workspace of await names(join(dataDir, "workspaces"))) {
      if (!await take(join(dataDir, "workspaces", workspace, "MEMORY.md"))) return null;
      if (!await walk(join(dataDir, "workspaces", workspace, "memory"), 0)) return null;
    }
    return parts.join("\n");
  }

  /** The links in a bot's own folder and its conversation folders, each with where it leads (a relative one resolved
   * from its folder): read once per pass for each bot; null when they were too many to look through. */
  async function botLinks(botId: string, view: View): Promise<Array<{ from: string; leads: string[] }> | null> {
    let scanned = 0;
    const links: Array<{ from: string; leads: string[] }> = [];
    const walk = async (dir: string, depth: number): Promise<boolean> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return true; }
      for (const entry of entries) {
        if (++scanned > MAX_LINK_SCAN) return false;
        await step();
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          let target: string | null = null;
          try { target = resolve(dir, await readlink(path)); } catch { /* unreadable: its real path below, if any */ }
          links.push({ from: path, leads: [target, view.resolved(path)].filter((one): one is string => Boolean(one)) });
        } else if (entry.isDirectory() && depth < MAX_DEPTH && !LINK_SCAN_SKIP.has(entry.name)) {
          if (!await walk(path, depth + 1)) return false;
        }
      }
      return true;
    };
    const places = [join(dataDir, "workspaces", botId), ...readdirNames(join(tasksRoot, botId)).filter((name) => ID.test(name)).map((name) => join(tasksRoot, botId, name))];
    for (const place of places) if (realFolder(place) && !await walk(place, 0)) return null;
    return links;
  }

  /** Whether a link outside `folder`, in the bot's own folder or its other conversation folders, leads into it; null
   * when they were too many to look through. */
  async function linkedInto(botId: string, folder: string, view: View): Promise<boolean | null> {
    let found = view.links.get(botId);
    if (!found) view.links.set(botId, found = botLinks(botId, view));
    const links = await found;
    if (!links) return null;
    const own = [folder, view.resolved(folder)].filter((path): path is string => Boolean(path));
    return links.some((link) => !inside(folder, link.from) && link.leads.some((lead) => own.some((mine) => inside(mine, lead))));
  }

  /** What in the records still uses this conversation folder, or null: the quick check, made again before each move.
   * `ownThread`: the folder's own conversation remains and may keep it (an idle one, host/idle-reclaim.ts); any other user
   * still holds it. */
  function heldByRecords(folder: string, view: View, ownThread?: string): string | null {
    const [botId, threadId, ...rest] = relative(tasksRoot, folder).split(sep);
    if (!botId || !threadId || rest.length || !ID.test(botId) || !ID.test(threadId)) return "not a conversation folder";
    if (ownThread !== undefined && ownThread !== threadId) return "not that conversation's folder";
    if (!plainFolderUnder(dataDir, tasksRoot, folder)) return "not a plain folder in task-workspaces";
    const { live, folders } = view.now(ownThread);
    if (live.has(threadId) && ownThread === undefined) return "its conversation remains";
    const own = [folder, view.resolved(folder)].filter((path): path is string => Boolean(path));
    const tops = [dataDir, view.resolved(dataDir)].filter((path): path is string => Boolean(path));
    for (const path of folders) {
      // In the folder or inside it, or between it and the data folder (which sees it whole).
      if (own.some((mine) => within(mine, path) || (within(path, mine) && tops.some((top) => within(top, path))))) return `a remaining conversation works in ${path}`;
    }
    const held = deps.heldText ? deps.heldText() : "";
    if (held === null) return "the settings cannot be read yet";
    if (folderMentions(botId, threadId).some((fragment) => fold(held).includes(fold(fragment)))) return "the settings or a routine name a path in it";
    return null;
  }

  /** Everything that may still use this conversation folder, or null: the records, the saved definitions and
   * instructions, links from the bot's other folders, processes and the remaining conversations' messages. */
  async function heldBy(folder: string, view: View, mentioned: ReadonlyMap<string, ReadonlySet<string>> | null, ownThread?: string): Promise<string | null> {
    const quick = heldByRecords(folder, view, ownThread);
    if (quick) return quick;
    const [botId, threadId] = relative(tasksRoot, folder).split(sep) as [string, string];
    // Read once per view: a batch of deletes, or an idle reclaim's pass.
    const saved = await (view.saved ??= savedText());
    if (saved === null) return "the saved definitions cannot be read";
    if (folderMentions(botId, threadId).some((fragment) => fold(saved).includes(fold(fragment)))) return "the saved definitions or instructions name a path in it";
    const linked = await linkedInto(botId, folder, view);
    if (linked === null) return "the bot's other folders hold too many entries to check for links into it";
    if (linked) return "a link in the bot's other folders leads into it";
    if (deps.processFolders) {
      const cwds = await deps.processFolders();
      const own = [folder, view.resolved(folder)].filter((path): path is string => Boolean(path));
      if (cwds && cwds.some((cwd) => own.some((mine) => inside(mine, cwd)))) return "a process works in it";
    }
    if (deps.mentions) {
      if (!mentioned) return "the transcripts cannot be read";
      const live = view.now().live;
      if ([...(mentioned.get(threadId) ?? [])].some((id) => id !== threadId && live.has(id))) return "a remaining conversation names it";
    }
    return null;
  }

  /** Why an install candidate must stay, or null when it is plainly an install a package manager makes again. */
  async function notAnInstall(path: string, folder: string): Promise<string | null> {
    const isFile = async (file: string) => (await lstat(file).catch(() => null))?.isFile() === true;
    const name = path.slice(path.lastIndexOf(sep) + 1);
    if (name === "node_modules") {
      let marked = false;
      for (const marker of NODE_MARKERS) if (await isFile(join(path, marker))) marked = true;
      if (!marked) return "no package manager's record in it";
      if (!await isFile(join(dirname(path), "package.json"))) return "no package.json beside it";
      // A repository that commits its node_modules keeps it.
      for (let at = dirname(path); inside(folder, at); at = dirname(at)) {
        const dotGit = await lstat(join(at, ".git")).catch(() => null);
        if (!dotGit) { if (at === folder) break; continue; }
        if (!dotGit.isDirectory()) return "inside a git checkout whose index cannot be read";
        const tracked = await gitTracks(join(at, ".git", "index"), relative(at, path).split(sep).join("/"));
        if (tracked === null) return "inside a git checkout whose index cannot be read";
        if (tracked) return "git tracks it";
        break;
      }
      return null;
    }
    let entries: string[];
    try { entries = await readdir(path); } catch { return "cannot be read"; }
    const other = entries.filter((entry) => !VENV_ENTRIES.has(entry));
    return other.length ? `holds ${other.slice(0, 3).join(", ")}${other.length > 3 ? ", …" : ""}` : null;
  }

  /** The installs in a conversation folder, never through a link nor into .git, each with its identity. */
  async function rebuildable(folder: string, report = (_path: string, _why: string) => {}): Promise<FoundTree[]> {
    const found: FoundTree[] = [];
    let scanned = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (++scanned > MAX_SCANNED) return;
        await step();
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git") continue;
        const path = join(dir, entry.name);
        const candidate = entry.name === "node_modules" || ((entry.name === ".venv" || entry.name === "venv") && (await lstat(join(path, "pyvenv.cfg")).catch(() => null))?.isFile() === true);
        if (candidate) {
          const why = await notAnInstall(path, folder);
          const stats = why ? null : await lstat(path).catch(() => null);
          if (why) report(path, why);
          else if (stats?.isDirectory()) found.push({ path, dev: stats.dev, ino: stats.ino });
        } else if (depth < MAX_DEPTH) await walk(path, depth + 1);
      }
    };
    await walk(folder, 0);
    return found;
  }

  const sameNode = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;

  /** Moves `tree` into .removing; false (and the tree untouched) when that cannot be done safely. The move lands first
   * under a name the drain never takes (check-…), is compared there by device and inode, and only then gets the drain's
   * name; something else moved there (a link swapped in on the way) is put back, and if that fails it stays under check-…
   * for a person to look at, never drained. */
  async function retire(root: string, tree: FoundTree): Promise<boolean> {
    const paused = deps.paused?.() ?? null;
    if (paused) { log(`cleanup: kept ${tree.path} for now: ${paused}`); return false; }
    try {
      await mkdir(removing, { recursive: true, mode: 0o700 });
      if (!plainFolderUnder(dataDir, dataDir, removing)) throw new Error(`${REMOVING_DIR} is not a plain folder`);
      if (!plainFolderUnder(dataDir, root, tree.path)) throw new Error("not a plain folder in the data folder");
      const before = lstatSync(tree.path);
      if (!before.isDirectory() || !sameNode(before, tree)) throw new Error("it changed since it was checked");
      const parent = realpathSync.native(dirname(tree.path));
      deps.beforeMove?.(tree.path);
      // The last look, with no wait before the move: the folder it is in is still where it was (no link swapped in).
      if (real(dirname(tree.path)) !== parent || !sameNode(lstatSync(tree.path), tree)) throw new Error("it changed since it was checked");
      const name = `${Date.now()}-${randomBytes(6).toString("hex")}`;
      const checking = join(removing, `check-${name}`);
      await rename(tree.path, checking);
      const moved = await lstat(checking);
      if (!sameNode(moved, tree)) {
        // Something else was moved: put it back where it was and keep it.
        try {
          await rename(checking, tree.path);
        } catch (error) {
          warn(`cleanup: MOVED SOMETHING ELSE AND COULD NOT PUT IT BACK: it is kept at ${checking} (it came from ${tree.path}, ${message(error)}); the cleanup never removes it`);
        }
        throw new Error("what was moved is not what was checked; put back");
      }
      await rename(checking, join(removing, name));
      return true;
    } catch (error) {
      warn(`cleanup: kept ${tree.path}: ${message(error)}`);
      return false;
    }
  }

  /** Removes one entry of .removing with Node, deepest first, a link as a link, never across a mount (`dev`); a folder
   * that is no longer the folder it was when listed (a link swapped in) is left for the next pass. Used where GNU rm is
   * not there (macOS, Windows); what fails stays for the next pass. */
  async function remove(path: string, dev: number, totals: CleanupTotals): Promise<void> {
    await step();
    let stats;
    try { stats = await lstat(path); } catch (error) { if (code(error) !== "ENOENT") totals.failed++; return; }
    if (stats.dev !== dev) { totals.failed++; return; }
    if (stats.isDirectory()) {
      let names: string[] = [];
      try { names = await readdir(path); } catch (error) {
        if (code(error) === "EACCES" || code(error) === "EPERM") { await chmod(path, 0o700).catch(() => {}); names = await readdir(path).catch(() => []); }
      }
      // The listing must be of the folder that was checked: a link swapped in before it is never walked.
      const again = await lstat(path).catch(() => null);
      if (!again || !again.isDirectory() || !sameNode(again, stats)) { totals.failed++; return; }
      for (const name of names) await remove(join(path, name), dev, totals);
    }
    const drop = () => (stats.isDirectory() ? rmdir(path) : unlink(path));
    try {
      await drop();
    } catch (error) {
      if (code(error) === "ENOENT") return;
      // A read-only file (Windows) or a folder without write permission: it and its folder made writable, then again;
      // only ever a real folder, never through a link.
      try {
        const parent = await lstat(dirname(path)).catch(() => null);
        if (parent?.isDirectory() && parent.dev === dev) await chmod(dirname(path), 0o700).catch(() => {});
        const self = await lstat(path).catch(() => null);
        if (self && !self.isSymbolicLink() && sameNode(self, stats)) await chmod(path, stats.isDirectory() ? 0o700 : 0o600).catch(() => {});
        await drop();
      } catch {
        totals.failed++;
        return;
      }
    }
    totals.entries++;
    totals.bytes += stats.isDirectory() ? 0 : stats.size;
  }

  /** Finishes what an earlier pass moved to .removing: only its own entries, only in a plain .removing, never one a
   * process still works in, holds open or has mapped (it is tried again on a later pass). On Linux the system's GNU rm
   * removes it (one file system, no link followed, a race-safe walk), at low priority. */
  async function drainPending(totals: CleanupTotals): Promise<void> {
    if (!realFolder(removing) || !plainFolderUnder(dataDir, dataDir, removing)) return;
    if (deps.paused?.()) return;
    const names = (await readdir(removing).catch(() => [] as string[])).filter((name) => RETIRED.test(name));
    if (!names.length) return;
    const held = await (deps.processPaths ?? linuxProcessPaths)();
    if (held === null && process.platform === "linux") return warn("cleanup: left .removing for now: which files processes hold cannot be read");
    const removingDev = lstatSync(removing).dev;
    const rm = await (deps.systemRm ?? gnuRm)();
    for (const name of names) {
      if (deps.paused?.()) return;
      const entry = join(removing, name);
      const stats = await lstat(entry).catch(() => null);
      if (!stats) continue;
      if (stats.dev !== removingDev) { totals.failed++; continue; }
      const realEntry = await realpath(entry).catch(() => entry);
      if (held && held.some((path) => within(entry, path) || within(realEntry, path))) { log(`cleanup: left ${entry} for now: a process still holds something in it`); continue; }
      if (!rm || !stats.isDirectory()) { await remove(entry, stats.dev, totals); continue; }
      const again = await lstat(entry).catch(() => null);
      if (!again || !sameNode(again, stats)) { totals.failed++; continue; }
      if (await runRm(rm, entry) || (await chmodTree(entry), await runRm(rm, entry))) totals.entries++;
      else totals.failed++;
    }
  }

  async function runJob(job: Job, totals: CleanupTotals, view: View, mentioned: () => Promise<ReadonlyMap<string, ReadonlySet<string>> | null>): Promise<void> {
    if (job.kind === "results") {
      const name = job.name;
      // A name another thread's results may also be kept under (the gate cuts names at 80 characters) stays.
      const shared = [...view.now().live].some((id) => hookResultsName(id) === name || gateResultsName(id) === name);
      if (shared || !ID.test(name) || name === "thread") return;
      const path = join(resultsRoot, name);
      const stats = await lstat(path).catch(() => null);
      if (stats?.isDirectory() && await retire(resultsRoot, { path, dev: stats.dev, ino: stats.ino })) totals.folders++;
      return;
    }
    if (!realFolder(job.folder)) return;
    const why = heldByRecords(job.folder, view);
    if (why) return log(`cleanup: kept ${job.folder}: ${why}`);
    const trees = await rebuildable(job.folder, (path, reason) => log(`cleanup: kept ${path}: ${reason}`));
    if (!trees.length) return;
    const late = await heldBy(job.folder, view, await mentioned());
    if (late) return log(`cleanup: kept ${job.folder}: ${late}`);
    for (const tree of trees) {
      // Checked again just before each move: a conversation may have started working there meanwhile.
      const again = heldByRecords(job.folder, view);
      if (again) return log(`cleanup: kept ${job.folder}: ${again}`);
      if (await retire(tasksRoot, tree)) totals.folders++;
    }
  }

  function kick(): void {
    if (active) return;
    active = true;
    running = running.then(async () => {
      const totals: CleanupTotals = { folders: 0, entries: 0, bytes: 0, failed: 0 };
      try {
        while (queued.size) {
          const batch = [...queued.entries()];
          queued.clear();
          const view = batchView();
          await view.warm();
          // The transcripts are read once per batch, for every conversation in it, and only when one has an install.
          let mentioned: Promise<ReadonlyMap<string, ReadonlySet<string>> | null> | undefined;
          const ids = batch.flatMap(([, job]) => (job.kind === "workspace" ? [relative(tasksRoot, job.folder).split(sep)[1] ?? ""] : [])).filter((id) => ID.test(id));
          const read = () => (mentioned ??= deps.mentions
            ? deps.mentions(ids).then((found) => found, (error: unknown) => { warn(`cleanup: the transcripts could not be read: ${message(error)}`); return null; })
            : Promise.resolve(new Map()));
          for (const [key, job] of batch) {
            try { await runJob(job, totals, view, read); } catch (error) { warn(`cleanup: kept ${key}: ${message(error)}`); }
          }
        }
        await drainPending(totals);
      } catch (error) {
        warn(`cleanup: stopped: ${message(error)}`);
      } finally {
        active = false;
      }
      if (totals.folders || totals.entries) {
        log(`cleanup: removed ${totals.folders} install or tool-result folder(s) of deleted conversations, ${totals.entries} entries, ${Math.round(totals.bytes / 1024 / 1024)} MB${totals.failed ? `; ${totals.failed} left for the next pass` : ""}`);
      }
      if (queued.size) kick();
    });
  }

  function enqueue(job: Job): void {
    queued.set(job.kind === "workspace" ? `workspace:${job.folder}` : `results:${job.name}`, job);
  }

  const children = (dir: string) => (realFolder(dir) ? readdirNames(dir) : []);

  /** Deleted conversations: their folders under every bot (a room's under each member's), the conversation folders
   * they worked in (a fork's source's, which may now belong to nothing), and their tool results. */
  function conversationsGone(threadIds: Iterable<string>, workedIn: Iterable<string> = []): void {
    const ids = [...new Set(threadIds)].filter((id) => ID.test(id));
    if (!ids.length) return;
    for (const used of workedIn) {
      if (!isAbsolute(used)) continue;
      const [botId, threadId, ...rest] = relative(tasksRoot, resolve(used)).split(sep);
      if (botId && threadId && !rest.length && ID.test(botId) && ID.test(threadId)) enqueue({ kind: "workspace", folder: join(tasksRoot, botId, threadId) });
    }
    const bots = children(tasksRoot).filter((id) => ID.test(id));
    for (const threadId of ids) {
      for (const botId of bots) if (realFolder(join(tasksRoot, botId, threadId))) enqueue({ kind: "workspace", folder: join(tasksRoot, botId, threadId) });
      enqueue({ kind: "results", name: threadId });
    }
    kick();
  }

  /** A deleted bot: each of its conversation folders, including those of conversations deleted before it. */
  function botGone(botId: string): void {
    if (!ID.test(botId)) return;
    for (const threadId of children(join(tasksRoot, botId))) if (ID.test(threadId)) enqueue({ kind: "workspace", folder: join(tasksRoot, botId, threadId) });
    kick();
  }

  /** Folders the orphan sweep found: conversation folders (their installs go) and tool-results folder names. */
  function orphans(found: { workspaces?: Iterable<string>; results?: Iterable<string> }): void {
    for (const folder of found.workspaces ?? []) {
      const [botId, threadId, ...rest] = relative(tasksRoot, resolve(folder)).split(sep);
      if (botId && threadId && !rest.length && ID.test(botId) && ID.test(threadId)) enqueue({ kind: "workspace", folder: join(tasksRoot, botId, threadId) });
    }
    for (const name of found.results ?? []) if (ID.test(name)) enqueue({ kind: "results", name });
    kick();
  }

  if (deps.drainAfterMs !== false) setTimeout(kick, deps.drainAfterMs ?? DRAIN_AFTER_START_MS).unref?.();

  /** An idle conversation's own folder (host/idle-reclaim.ts): its installs, after every check above except that its
   * own conversation remains; `kept` says why none may go. Links from the bot's other folders, processes, the saved
   * definitions and the other conversations' messages are checked as for a deleted one. */
  async function idleInstalls(folder: string, threadId: string, pass: IdlePass, report?: (path: string, why: string) => void): Promise<{ trees: FoundTree[]; kept: string | null }> {
    const view = pass.view as View;
    const quick = heldByRecords(folder, view, threadId);
    if (quick) return { trees: [], kept: quick };
    const trees = await rebuildable(folder, report);
    if (!trees.length) return { trees, kept: null };
    const late = await heldBy(folder, view, await pass.mentioned(), threadId);
    return late ? { trees: [], kept: late } : { trees, kept: null };
  }

  /** One idle reclaim pass's view, read once: the live folders resolved, the bots' links, the saved definitions, and
   * which conversations' messages name each of `threadIds` (one read of the transcripts). */
  async function idlePass(threadIds: readonly string[]): Promise<IdlePass> {
    const view = batchView();
    await view.warm();
    let mentioned: Promise<ReadonlyMap<string, ReadonlySet<string>> | null> | undefined;
    const ids = threadIds.filter((id) => ID.test(id));
    return {
      view,
      mentioned: () => (mentioned ??= deps.mentions && ids.length
        ? deps.mentions(ids).then((found) => found, (error: unknown) => { warn(`cleanup: the transcripts could not be read: ${message(error)}`); return null; })
        : Promise.resolve(new Map())),
    };
  }

  /** Moves one tree of an idle conversation's folder into .removing, after the records' check again and `still()`
   * (null while the conversation is still idle), both just before the rename. */
  async function retireIdle(folder: string, threadId: string, tree: FoundTree, pass: IdlePass, still: () => string | null): Promise<string | null> {
    if (!inside(folder, tree.path) || fold(resolve(folder)) === fold(resolve(tree.path))) return "not inside that conversation's folder";
    const why = heldByRecords(folder, pass.view as View, threadId) ?? still();
    if (why) return why;
    return (await retire(tasksRoot, tree)) ? null : "it could not be moved safely";
  }

  return {
    conversationsGone,
    botGone,
    orphans,
    idlePass,
    idleInstalls,
    retireIdle,
    /** What in the records still uses a conversation folder, or null when nothing there does. */
    whyKept: (folder: string) => heldByRecords(folder, batchView()),
    /** Its installs, and through `report` the look-alikes that stay. */
    rebuildable,
    /** Finishes what an earlier run left in .removing. */
    drain: () => { kick(); return running; },
    /** Resolves once everything queued so far is done. */
    idle: async () => { while (active || queued.size) { kick(); await running; } },
  };
}

/** Synchronous on purpose and shallow: one listing of bot or conversation names, never a tree. */
function readdirNames(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export type ConversationFolderCleanup = ReturnType<typeof createConversationFolderCleanup>;
