// What a deleted conversation or bot leaves in its folders that is nobody's work: the dependency and build trees in its
// conversation folders (task-workspaces/<bot>/<thread>: node_modules, a Python venv, a Rust target folder), which an
// install or a build makes again, and the full tool results kept for it (tool-results/<thread>). The files the bot
// made for the person stay: the delete dialogs promise them ("Generated project files are kept"), Files lists every
// conversation folder that holds a file and brings it to the person's computer, and the bot's other conversations are
// told where these folders are. Event logs and engine sessions go with the conversation elsewhere (store.ts,
// delete-leftovers.ts).
//
// Safety: a folder is touched only when nothing that remains can use it. Its conversation is no remaining bot's or
// room's (a room's turns use a member bot's conversation folder under the room's own id), no remaining bot, conversation
// or room works in it, inside it or in a folder between it and the data folder (a fork keeps working in its source's
// folder), and the saved settings name no path in it. That is checked again just before each move. Nothing is reached
// through a link: every folder from the data folder down must be a real folder, and a link found while removing is
// removed as a link. What goes is first moved, in one rename, to <data>/.removing, and only then removed one entry at
// a time, so a crash leaves either the whole tree in place or a part of it in .removing, which the next start finishes.
// Nothing runs on the delete's own call: the work is queued, awaited one file at a time and paced, so a tree of
// hundreds of thousands of files never holds a turn or the event loop. Any failure is logged and keeps what it touched.
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const REMOVING_DIR = ".removing";
const ID = /^[\w-]{1,128}$/;
const MAX_DEPTH = 8;
const MAX_SCANNED = 200_000;
const YIELD_EVERY = 256;
const PAUSE_EVERY = 4_096;
const PAUSE_MS = 20;
const DRAIN_AFTER_START_MS = 60_000;

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

export function liveFolders(records: LiveRecords): string[] {
  const folders: Folder[] = [];
  for (const bot of records.bots) folders.push(bot.cwd, ...(bot.tasks ?? []).flatMap((task) => [task.cwd, task.pinnedCwd]));
  for (const group of records.groups) folders.push(group.cwd, group.pinnedCwd, ...(group.tasks ?? []).flatMap((task) => [task.cwd, task.pinnedCwd]));
  return folders.filter((folder): folder is string => typeof folder === "string" && isAbsolute(folder));
}

/** The folder names a thread's full tool results are kept under: the hook's (index.ts) and the MCP gate's
 * (mcp-gate-config.ts spillDir). */
export const hookResultsName = (threadId: string) => threadId.replace(/[^\w.-]/g, "_");
export const gateResultsName = (threadId: string) => threadId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "thread";

export interface FolderCleanupDeps {
  dataDir: string;
  records(): LiveRecords;
  /** Saved settings that may name a path (MCP servers' commands and arguments); a conversation folder they name stays. */
  heldText?(): string;
  /** When the start's leftover .removing is finished; false: only on request. Default: a minute after start. */
  drainAfterMs?: number | false;
  pause?(ms: number): Promise<void>;
  log?(line: string): void;
  warn?(line: string): void;
}

type Job = { kind: "workspace"; folder: string } | { kind: "results"; threadId: string };
export interface CleanupTotals { folders: number; entries: number; bytes: number; failed: number }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const code = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
function real(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}
function realFolder(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
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

  /** One step of file work: every so often the event loop gets a turn, and now and then the disk a rest. */
  async function step(): Promise<void> {
    steps++;
    if (steps % PAUSE_EVERY === 0) await pause(PAUSE_MS);
    else if (steps % YIELD_EVERY === 0) await new Promise<void>((done) => setImmediate(done));
  }

  /** Whether every folder from the data folder down to `path` (itself included) is a real folder, not a link. */
  function plainFolderUnder(root: string, path: string): boolean {
    if (!inside(dataDir, root) || !inside(root, path) || resolve(path) === resolve(root)) return false;
    let at = dataDir;
    for (const part of relative(dataDir, resolve(path)).split(sep)) {
      at = join(at, part);
      if (!realFolder(at)) return false;
    }
    const realData = real(dataDir), realPath = real(path);
    return Boolean(realData && realPath && inside(realData, realPath));
  }

  /** What still uses this conversation folder, or null when nothing that remains can. */
  function heldBy(folder: string): string | null {
    const [botId, threadId, ...rest] = relative(tasksRoot, folder).split(sep);
    if (!botId || !threadId || rest.length || !ID.test(botId) || !ID.test(threadId)) return "not a conversation folder";
    if (!plainFolderUnder(tasksRoot, folder)) return "not a plain folder in task-workspaces";
    const records = deps.records();
    if (liveThreadIds(records).has(threadId)) return "its conversation remains";
    const own = [folder, real(folder)].filter((path): path is string => Boolean(path));
    const tops = [dataDir, real(dataDir)].filter((path): path is string => Boolean(path));
    for (const used of new Set(liveFolders(records))) {
      for (const path of new Set([resolve(used), real(used)].filter((one): one is string => Boolean(one)))) {
        // In the folder or inside it, or between it and the data folder (which sees it whole).
        if (own.some((mine) => inside(mine, path) || (inside(path, mine) && tops.some((top) => inside(top, path))))) return `a remaining conversation works in ${path}`;
      }
    }
    const held = deps.heldText?.() ?? "";
    const named = [`task-workspaces/${botId}/${threadId}`, `task-workspaces\\${botId}\\${threadId}`, `task-workspaces\\\\${botId}\\\\${threadId}`];
    if (named.some((fragment) => held.includes(fragment))) return "the saved settings name a path in it";
    return null;
  }

  /** The dependency and build trees in a conversation folder, never through a link nor into .git. */
  async function rebuildable(folder: string): Promise<string[]> {
    const found: string[] = [];
    let scanned = 0;
    const isFile = async (path: string) => (await lstat(path).catch(() => null))?.isFile() === true;
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (++scanned > MAX_SCANNED) return;
        await step();
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git") continue;
        const path = join(dir, entry.name);
        if (entry.name === "node_modules") found.push(path);
        else if ((entry.name === ".venv" || entry.name === "venv") && await isFile(join(path, "pyvenv.cfg"))) found.push(path);
        else if (entry.name === "target" && await isFile(join(dir, "Cargo.toml"))) found.push(path);
        else if (depth < MAX_DEPTH) await walk(path, depth + 1);
      }
    };
    await walk(folder, 0);
    return found;
  }

  /** Moves `path` into .removing in one rename; false (and `path` untouched) when that cannot be done safely. */
  async function retire(root: string, path: string): Promise<boolean> {
    if (!plainFolderUnder(root, path)) return false;
    try {
      await mkdir(removing, { recursive: true, mode: 0o700 });
      if (!realFolder(removing)) throw new Error(`${REMOVING_DIR} is not a plain folder`);
      await rename(path, join(removing, `${Date.now()}-${randomBytes(6).toString("hex")}`));
      return true;
    } catch (error) {
      warn(`cleanup: kept ${path}: ${message(error)}`);
      return false;
    }
  }

  /** Removes one entry of .removing, deepest first, a link as a link; what fails stays for the next pass. */
  async function remove(path: string, totals: CleanupTotals): Promise<void> {
    await step();
    let stats;
    try { stats = await lstat(path); } catch (error) { if (code(error) !== "ENOENT") totals.failed++; return; }
    if (stats.isDirectory()) {
      let names: string[] = [];
      try { names = await readdir(path); } catch (error) {
        if (code(error) === "EACCES" || code(error) === "EPERM") { await chmod(path, 0o700).catch(() => {}); names = await readdir(path).catch(() => []); }
      }
      for (const name of names) await remove(join(path, name), totals);
    }
    const drop = () => (stats.isDirectory() ? rmdir(path) : unlink(path));
    try {
      await drop();
    } catch (error) {
      if (code(error) === "ENOENT") return;
      // A read-only file (Windows) or a folder without write permission: made writable once, then tried again.
      try {
        await chmod(path, stats.isDirectory() ? 0o700 : 0o600);
        await drop();
      } catch {
        totals.failed++;
        return;
      }
    }
    totals.entries++;
    totals.bytes += stats.isDirectory() ? 0 : stats.size;
  }

  async function drainPending(totals: CleanupTotals): Promise<void> {
    if (!realFolder(removing)) return;
    for (const name of await readdir(removing).catch(() => [] as string[])) await remove(join(removing, name), totals);
  }

  async function runJob(job: Job, totals: CleanupTotals): Promise<void> {
    if (job.kind === "results") {
      const records = deps.records();
      const name = job.threadId;
      // A name another thread's results may also be kept under (the gate cuts names at 80 characters) stays.
      const shared = [...liveThreadIds(records)].some((id) => hookResultsName(id) === name || gateResultsName(id) === name);
      if (shared || !ID.test(name)) return;
      const path = join(resultsRoot, name);
      if (realFolder(path) && await retire(resultsRoot, path)) totals.folders++;
      return;
    }
    if (!realFolder(job.folder)) return;
    const why = heldBy(job.folder);
    if (why) return log(`cleanup: kept ${job.folder}: ${why}`);
    for (const path of await rebuildable(job.folder)) {
      // Checked again just before each move: a conversation may have started working there meanwhile.
      if (heldBy(job.folder)) return;
      if (await retire(tasksRoot, path)) totals.folders++;
    }
  }

  function kick(): void {
    if (active) return;
    active = true;
    running = running.then(async () => {
      const totals: CleanupTotals = { folders: 0, entries: 0, bytes: 0, failed: 0 };
      try {
        while (queued.size) {
          const [key, job] = queued.entries().next().value as [string, Job];
          queued.delete(key);
          try { await runJob(job, totals); } catch (error) { warn(`cleanup: kept ${key}: ${message(error)}`); }
        }
        await drainPending(totals);
      } catch (error) {
        warn(`cleanup: stopped: ${message(error)}`);
      } finally {
        active = false;
      }
      if (totals.folders || totals.entries) {
        log(`cleanup: removed ${totals.folders} dependency, build or tool-result folder(s) of deleted conversations, ${totals.entries} entries, ${Math.round(totals.bytes / 1024 / 1024)} MB${totals.failed ? `; ${totals.failed} left for the next pass` : ""}`);
      }
      if (queued.size) kick();
    });
  }

  function enqueue(job: Job): void {
    queued.set(job.kind === "workspace" ? `workspace:${job.folder}` : `results:${job.threadId}`, job);
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
      enqueue({ kind: "results", threadId });
    }
    kick();
  }

  /** A deleted bot: each of its conversation folders, including those of conversations deleted before it. */
  function botGone(botId: string): void {
    if (!ID.test(botId)) return;
    for (const threadId of children(join(tasksRoot, botId))) if (ID.test(threadId)) enqueue({ kind: "workspace", folder: join(tasksRoot, botId, threadId) });
    kick();
  }

  if (deps.drainAfterMs !== false) setTimeout(kick, deps.drainAfterMs ?? DRAIN_AFTER_START_MS).unref?.();

  return {
    conversationsGone,
    botGone,
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
