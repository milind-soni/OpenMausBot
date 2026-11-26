// When a Cloud home's volume fills, the installs of conversations nobody has used for days go first: a node_modules or
// a Python venv a package manager makes again from the project's own lockfile, and the pnpm store that a conversation
// folder holds for them, never the project's own files. Behind OMB_IDLE_RECLAIM, off unless set: "report" says what a
// pass would shed and the bytes, and changes nothing; "remove" sheds it. Cloud homes only (index.ts starts it beside
// the orphan sweep). Modelled on the disk budget of an open-source agent server, which sheds the git-ignored folders of
// stopped conversations, least recently active first, while its filesystem is past a share of its size.
//
// When: nothing happens below the budget. At START_USED of the volume used a pass starts shedding, and it goes on, pass
// after pass, until STOP_USED (the gap keeps it from waking at every small write). Conversations idle longest go
// first, and none idle for less than MIN_IDLE_MS, by its newest message and by its folder's and each install's own
// newest change: a conversation someone left for lunch is never touched.
//
// What: only per-conversation folders (task-workspaces/<bot>/<thread>), never a bot's own folder (workspaces/<bot>),
// whose files are the bot's ongoing work and which no idle rule describes. Only what conversation-folder-cleanup.ts
// already counts as an install (a node_modules with a package manager's record and a package.json beside it, that git
// does not track; a venv holding only a venv's entries), and further here:
// - a lockfile beside it (a node_modules) or a manifest (a venv), so the reinstall brings the same packages back;
// - inside a git checkout, git ignores it (check-ignore, with the repository's own config unable to run anything);
// - no checkout inside it, three levels down;
// - no process works in it, holds a file of it open or has one of its files mapped (a native module).
// A pnpm store at the conversation folder's top (.pnpm-store: pnpm puts it there when it cannot link into the one under
// HOME, which a box's separate mount for each conversation prevents) goes only with every node_modules of that folder,
// since those are hard links into it and shedding them alone frees nothing.
//
// How: through the checked mover of conversation-folder-cleanup.ts (one rename into .removing, device and inode before
// and after, removal paced after), with every check there except that its own conversation remains, then the checks
// above, then just before each move: the conversation and its bot run no turn, it is not handed off, it has no newer
// message, and nothing is frozen after a move or being backed up or restored. A conversation that wakes mid-pass keeps
// what was not moved yet. Its bot is told once, on its next turn there, what went and how to put it back
// (idleReclaimNote). The numbers go to the log and to idle-reclaim.json, which the storage view can read.
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { lstat, readdir, statfs } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { inside, linuxProcessPaths, type ConversationFolderCleanup, type FoundTree, type LiveRecords } from "./conversation-folder-cleanup.ts";

export { linuxProcessPaths };

export const IDLE_RECLAIM_ENV = "OMB_IDLE_RECLAIM";
export type IdleReclaimMode = "off" | "report" | "remove";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Every number of the policy, in one place. None is a setting. */
export const IDLE_RECLAIM = {
  startUsed: 0.7,
  stopUsed: 0.6,
  minIdleMs: 3 * DAY_MS,
  firstPassMs: 15 * 60 * 1000,
  everyMs: 30 * 60 * 1000,
  /** Entries a "report" pass reads to measure what it would shed. */
  perPassEntries: 5_000_000,
  /** Conversations waiting for their note; the oldest go past it. */
  maxNotes: 2_000,
  notePaths: 5,
  /** A note is given again for this long after its first turn, so a turn started again (a recovery) still carries it. */
  noteRepeatMs: 10 * 60 * 1000,
  /** A pass in "remove" that found nothing to shed waits this long, unless the volume fills by quietRise meanwhile. */
  quietMs: 6 * 60 * 60 * 1000,
  quietRise: 0.05,
  /** Kinds of reasons a report counts. */
  maxReasons: 20,
} as const;
const STATE_FILE = "idle-reclaim.json";
const ID = /^[\w-]{1,128}$/;
const NODE_LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const PYTHON_MANIFESTS = ["uv.lock", "requirements.txt", "pyproject.toml", "Pipfile.lock", "poetry.lock", "pdm.lock"];
const PNPM_STORE = ".pnpm-store";
const YIELD_EVERY = 256;
const PAUSE_EVERY = 4_096;
const PAUSE_MS = 20;

export function idleReclaimMode(env: NodeJS.ProcessEnv = process.env): IdleReclaimMode {
  const value = env[IDLE_RECLAIM_ENV]?.trim().toLowerCase();
  if (value === "report" || value === "dry-run") return "report";
  if (value === "remove") return "remove";
  return "off";
}

type Stamped = { threadId: string; createdAt?: number; updatedAt?: number; archivedAt?: number; closedBy?: { at?: number } };
/** The records with each conversation's stamps (the store's bots and rooms). */
export interface StampedRecords extends LiveRecords {
  readonly bots: ReadonlyArray<LiveRecords["bots"][number] & { tasks?: ReadonlyArray<Stamped & { cwd?: string | null; pinnedCwd?: string | null }> }>;
  readonly groups: ReadonlyArray<LiveRecords["groups"][number] & { tasks?: ReadonlyArray<Stamped & { cwd?: string | null; pinnedCwd?: string | null }> }>;
}

/** Newest activity of each registered conversation: its newest message, close or archive, across bots and rooms. */
export function lastActivity(records: StampedRecords): Map<string, number> {
  const at = new Map<string, number>();
  for (const owner of [...records.bots, ...records.groups]) {
    for (const task of owner.tasks ?? []) {
      const newest = Math.max(task.updatedAt ?? 0, task.createdAt ?? 0, task.closedBy?.at ?? 0, task.archivedAt ?? 0);
      at.set(task.threadId, Math.max(at.get(task.threadId) ?? 0, newest));
    }
  }
  return at;
}

export interface Volume { usedBytes: number; freeBytes: number }
export async function volumeOf(path: string): Promise<Volume | null> {
  try {
    const stats = await statfs(path);
    return { usedBytes: (stats.blocks - stats.bfree) * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch { return null; }
}
const usedShare = (volume: Volume) => (volume.usedBytes + volume.freeBytes > 0 ? volume.usedBytes / (volume.usedBytes + volume.freeBytes) : 0);

/** git in a checkout the bots write: nothing in it may run (no fsmonitor, no global or system config, no prompt). */
function git(top: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0" };
    execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "--no-optional-locks", "-C", top, ...args],
      { env, timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null) : 0;
        done({ code, out: String(stdout ?? "") });
      });
  });
}

/** Whether git ignores the folder `rel` (relative to the checkout `top`) and tracks nothing inside it: null when git
 * cannot tell. A force-added file inside an ignored folder is tracked, and keeps it. */
export async function gitIgnores(top: string, rel: string): Promise<boolean | null> {
  const path = `${rel.split(sep).join("/")}/`;
  const ignored = await git(top, ["check-ignore", "-q", "--", path]);
  if (ignored.code === 1) return false;
  if (ignored.code !== 0) return null;
  const tracked = await git(top, ["ls-files", "-z", "--cached", "--", path]);
  if (tracked.code !== 0) return null;
  return tracked.out.length === 0;
}

export interface IdleReclaimReport {
  at: number;
  mode: IdleReclaimMode;
  /** Why the pass looked at nothing (below the budget, paused, off). */
  skipped?: string;
  /** Share of the volume used when the pass started, and when it ended ("remove"), or as it would be ("report"). */
  usedBefore: number | null;
  usedAfter: number | null;
  /** Conversation folders idle long enough, those something was shed from (or would be), and those kept whole. */
  conversations: { idle: number; shed: number; kept: number; woke: number };
  /** Why folders stayed, by kind of reason (paths left out), at most IDLE_RECLAIM.maxReasons kinds. */
  keptBecause: Record<string, number>;
  folders: number;
  /** "remove": what the volume gained; "report": what the installs hold, each file once. */
  bytes: number;
  /** The pass stopped at STOP_USED with idle conversations left. */
  reachedTarget: boolean;
  /** "report" ran out of its reading budget. */
  partial: boolean;
}
export interface IdleNote { at: number; paths: string[]; givenAt?: number }
interface State { reclaiming: boolean; quietUntil?: number; quietAtUsed?: number; notes: Record<string, IdleNote>; totals: { passes: number; folders: number; conversations: number; freedBytes: number }; last?: IdleReclaimReport }
const fresh = (): State => ({ reclaiming: false, notes: {}, totals: { passes: 0, folders: 0, conversations: 0, freedBytes: 0 } });

/** The saved state, field by field; anything unreadable starts again from nothing. */
function readState(dataDir: string): State {
  try {
    const read = JSON.parse(readFileSync(join(dataDir, STATE_FILE), "utf8")) as Partial<State>;
    const state = fresh();
    state.reclaiming = read.reclaiming === true;
    if (typeof read.quietUntil === "number" && typeof read.quietAtUsed === "number") { state.quietUntil = read.quietUntil; state.quietAtUsed = read.quietAtUsed; }
    for (const [id, note] of Object.entries(read.notes ?? {})) {
      if (ID.test(id) && note && typeof note.at === "number" && Array.isArray(note.paths)) {
        state.notes[id] = { at: note.at, paths: note.paths.filter((one) => typeof one === "string").slice(0, IDLE_RECLAIM.notePaths + 1), ...(typeof note.givenAt === "number" ? { givenAt: note.givenAt } : {}) };
      }
    }
    const totals = read.totals ?? state.totals;
    for (const key of Object.keys(state.totals) as Array<keyof State["totals"]>) if (typeof totals[key] === "number" && Number.isFinite(totals[key]) && totals[key] >= 0) state.totals[key] = totals[key];
    if (read.last && typeof read.last === "object") state.last = read.last;
    return state;
  } catch { return fresh(); }
}
/** Read, change and save in one synchronous step, so a note taken by a turn is never written back by a pass. */
function updateState(dataDir: string, change: (state: State) => void): State {
  const state = readState(dataDir);
  change(state);
  const ids = Object.keys(state.notes);
  if (ids.length > IDLE_RECLAIM.maxNotes) for (const id of ids.sort((a, b) => state.notes[a]!.at - state.notes[b]!.at).slice(0, ids.length - IDLE_RECLAIM.maxNotes)) delete state.notes[id];
  writeFileAtomic(join(dataDir, STATE_FILE), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  return state;
}

/** The one line a bot's next turn in a conversation carries after its installs were shed; "" otherwise. Given again only
 * within noteRepeatMs of its first turn (that turn started again), then dropped. */
/** A folder path the note may show to the bot. */
const SHOWN_NAME = /^[\w.@+/-]+$/;

export function idleReclaimNote(dataDir: string, threadId: string, now = Date.now()): string {
  try { statSync(join(dataDir, STATE_FILE)); } catch { return ""; }
  if (!ID.test(threadId) || !readState(dataDir).notes[threadId]) return "";
  let note: IdleNote | undefined;
  try {
    updateState(dataDir, (state) => {
      const found = state.notes[threadId];
      if (!found) return;
      if (found.givenAt !== undefined && now - found.givenAt > IDLE_RECLAIM.noteRepeatMs) { delete state.notes[threadId]; return; }
      note = found;
      found.givenAt ??= now;
    });
  } catch { return ""; }
  if (!note) return "";
  // A folder's name is shown only when it is plainly a name: a cloned repository names its own folders, and a name is
  // read by the bot as part of this note.
  const named = note.paths.map((path) => (path ? path.split(sep).join("/") : ".")).filter((path) => SHOWN_NAME.test(path));
  const shown = named.slice(0, IDLE_RECLAIM.notePaths);
  const more = note.paths.length > shown.length ? (shown.length ? " and more" : "some folders") : "";
  return `\n\n[From OpenMausBot, not the person: to free disk space while this conversation was idle, its installed dependencies were removed (${shown.join(", ")}${more}). The project's own files, lockfiles and git history are unchanged. Before you run the project again, reinstall from its lockfile (npm ci, pnpm install, yarn install, bun install, uv sync or pip install -r requirements.txt); do not mention this unless it matters to the person.]`;
}

/** What the storage view may say: the switch, the last pass and what every pass has freed. */
export function idleReclaimSummary(dataDir: string): { last: IdleReclaimReport | null; totals: State["totals"] } {
  const state = readState(dataDir);
  return { last: state.last ?? null, totals: state.totals };
}

export interface IdleReclaimDeps {
  dataDir: string;
  mode(): IdleReclaimMode;
  records(): StampedRecords;
  /** A turn runs in this conversation, or one is claimed for it. */
  busy(botId: string, threadId: string): boolean;
  /** The bot runs a turn anywhere (its own chat, a conversation, a room). */
  botBusy(botId: string): boolean;
  /** Another bot holds this conversation in a hand-off. */
  handedOff(threadId: string): boolean;
  /** Why nothing may change now (frozen after a move, a backup being made or restored), else null. */
  paused?(): string | null;
  cleanup: Pick<ConversationFolderCleanup, "idlePass" | "idleInstalls" | "retireIdle" | "drain">;
  volume?(path: string): Promise<Volume | null>;
  /** linuxProcessPaths by default: null keeps everything. */
  openPaths?(): Promise<readonly string[] | null>;
  gitIgnores?(top: string, rel: string): Promise<boolean | null>;
  now?(): number;
  pause?(ms: number): Promise<void>;
  limits?: { perPassEntries?: number };
  log?(line: string): void;
  warn?(line: string): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const pct = (share: number | null) => (share === null ? "?" : `${Math.round(share * 100)}%`);
const empty = (at: number, mode: IdleReclaimMode, skipped?: string, usedBefore: number | null = null): IdleReclaimReport => ({
  at, mode, ...(skipped ? { skipped } : {}), usedBefore, usedAfter: usedBefore, conversations: { idle: 0, shed: 0, kept: 0, woke: 0 }, keptBecause: {}, folders: 0, bytes: 0, reachedTarget: false, partial: false,
});

export function describeIdleReclaim(report: IdleReclaimReport): string {
  if (report.skipped) return `idle reclaim (${report.mode}): nothing done: ${report.skipped}`;
  const c = report.conversations;
  return `idle reclaim (${report.mode}): volume ${pct(report.usedBefore)} -> ${pct(report.usedAfter)}; ${c.idle} idle conversation(s), ` +
    `${report.mode === "remove" ? "shed" : "would shed"} ${report.folders} install folder(s) from ${c.shed}, ${gb(report.bytes)}; ${c.kept} kept whole` +
    `${c.woke ? `; ${c.woke} woke during the pass` : ""}${report.reachedTarget ? "; reached its target" : ""}${report.partial ? "; stopped at its reading budget" : ""}`;
}

class OverBudget extends Error {}

export async function reclaimIdle(deps: IdleReclaimDeps): Promise<IdleReclaimReport> {
  const dataDir = resolve(deps.dataDir);
  const now = (deps.now ?? Date.now)();
  const mode = deps.mode();
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const volume = deps.volume ?? volumeOf;
  if (mode === "off") return empty(now, mode, "off");
  const paused = deps.paused?.() ?? null;
  if (paused) return empty(now, mode, paused);
  const before = await volume(dataDir);
  if (!before) return empty(now, mode, "the volume could not be read");
  const usedBefore = usedShare(before);
  const state = readState(dataDir);
  // Hysteresis: a pass starts at startUsed and passes go on until stopUsed. A report never starts the remove's run.
  const over = usedBefore >= IDLE_RECLAIM.startUsed || (state.reclaiming && mode === "remove" && usedBefore > IDLE_RECLAIM.stopUsed);
  const save = (report: IdleReclaimReport, reclaiming: boolean, extra?: (state: State) => void) => {
    try {
      updateState(dataDir, (saved) => {
        saved.reclaiming = reclaiming;
        saved.last = report;
        saved.totals.passes++;
        extra?.(saved);
      });
    } catch (error) { warn(`idle reclaim: could not save its notes: ${message(error)}`); }
    return report;
  };
  if (!over) return save(empty(now, mode, `below its budget (${pct(usedBefore)} used, starts at ${pct(IDLE_RECLAIM.startUsed)})`, usedBefore), false, (saved) => { delete saved.quietUntil; delete saved.quietAtUsed; });
  if (mode === "remove" && state.quietUntil !== undefined && now < state.quietUntil && usedBefore < (state.quietAtUsed ?? 0) + IDLE_RECLAIM.quietRise) {
    return empty(now, mode, "the last pass found nothing to shed; waiting", usedBefore);
  }

  const total = before.usedBytes + before.freeBytes;
  const target = IDLE_RECLAIM.stopUsed * total;
  const report = empty(now, mode, undefined, usedBefore);
  const cutoff = now - IDLE_RECLAIM.minIdleMs;
  const openPaths = await (deps.openPaths ?? linuxProcessPaths)();
  const gitIgnored = deps.gitIgnores ?? gitIgnores;
  const tasksRoot = join(dataDir, "task-workspaces");
  const names = async (dir: string) => readdir(dir).catch(() => [] as string[]);
  const mtime = (path: string) => { try { return lstatSync(path).mtimeMs; } catch { return Infinity; } };

  // Conversation folders whose conversation is registered and idle long enough, idle longest first.
  const activity = lastActivity(deps.records());
  const candidates: Array<{ botId: string; threadId: string; folder: string; since: number }> = [];
  for (const botId of await names(tasksRoot)) {
    if (!ID.test(botId)) continue;
    for (const threadId of await names(join(tasksRoot, botId))) {
      const since = activity.get(threadId);
      if (!ID.test(threadId) || since === undefined || since > cutoff) continue;
      candidates.push({ botId, threadId, folder: join(tasksRoot, botId, threadId), since });
    }
  }
  candidates.sort((a, b) => a.since - b.since);

  let steps = 0;
  const step = async () => {
    if (++steps > (deps.limits?.perPassEntries ?? IDLE_RECLAIM.perPassEntries)) throw new OverBudget();
    if (steps % PAUSE_EVERY === 0) await pause(PAUSE_MS);
    else if (steps % YIELD_EVERY === 0) await new Promise<void>((done) => setImmediate(done));
  };
  const seen = new Set<string>();
  const windows = process.platform === "win32";
  const because = (why: string) => {
    // Never a name from the disk: a path is cut off, and what a look-alike holds is not said.
    const kind = why.startsWith("holds ") ? "holds other entries" : why.replace(/ (?:in|at|into) (?:\/|[A-Za-z]:[\\/]).*$/, "").slice(0, 80);
    if (kind in report.keptBecause || Object.keys(report.keptBecause).length < IDLE_RECLAIM.maxReasons) report.keptBecause[kind] = (report.keptBecause[kind] ?? 0) + 1;
  };
  /** Bytes under `path`, each hard-linked file once in the pass (a pnpm store and the node_modules linking into it). */
  const measure = async (path: string): Promise<number> => {
    await step();
    const stats = await lstat(path).catch(() => null);
    if (!stats) return 0;
    if (!stats.isDirectory()) {
      if (stats.nlink > 1) { const key = `${stats.dev}:${stats.ino}`; if (seen.has(key)) return 0; seen.add(key); }
      return windows ? stats.size : stats.blocks * 512;
    }
    let bytes = windows ? 0 : stats.blocks * 512;
    for (const name of await readdir(path).catch(() => [] as string[])) bytes += await measure(join(path, name));
    return bytes;
  };
  const isFile = (path: string) => { try { return lstatSync(path).isFile(); } catch { return false; } };
  const isDir = (path: string) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
  /** Why one install found by the mover must stay here, or null. */
  const extraHold = async (folder: string, tree: FoundTree): Promise<string | null> => {
    const parent = dirname(tree.path);
    const node = tree.path.endsWith(`${sep}node_modules`);
    if (node ? !NODE_LOCKS.some((name) => isFile(join(parent, name))) : !PYTHON_MANIFESTS.some((name) => isFile(join(parent, name)))) return "no lockfile or manifest beside it to reinstall from";
    if (mtime(tree.path) > cutoff) return "changed in the last days";
    for (const pattern of [[".git"], ["*", ".git"], ["*", "*", ".git"]]) {
      const levels = async (at: string, rest: string[]): Promise<boolean> => {
        if (rest.length === 1) return Boolean(await lstat(join(at, ".git")).catch(() => null));
        for (const name of await names(at)) if (isDir(join(at, name)) && await levels(join(at, name), rest.slice(1))) return true;
        return false;
      };
      if (await levels(tree.path, pattern)) return "a git checkout is inside it";
    }
    for (let at = parent; inside(folder, at); at = dirname(at)) {
      if (await lstat(join(at, ".git")).catch(() => null)) {
        const ignored = await gitIgnored(at, relative(at, tree.path));
        if (ignored === null) return "git could not say whether it ignores it";
        if (!ignored) return "git does not ignore it";
        break;
      }
      if (at === folder) break;
    }
    if (!openPaths) return "the processes' open files cannot be read";
    if (openPaths.some((path) => inside(tree.path, path))) return "a process uses it";
    return null;
  };

  let freedSoFar = 0, reclaiming = true, deferred = 0;
  const notes: Record<string, IdleNote> = {};
  const pass = await deps.cleanup.idlePass(candidates.map((candidate) => candidate.threadId));
  try {
    for (const candidate of candidates) {
      const { botId, threadId, folder } = candidate;
      if (before.usedBytes - freedSoFar <= target) { report.reachedTarget = true; reclaiming = false; break; }
      /** Null while the conversation stays as idle as when it was picked. */
      const still = (): string | null => {
        const why = deps.paused?.() ?? null;
        if (why) return why;
        if (deps.busy(botId, threadId) || deps.botBusy(botId)) return "its bot is working";
        if (deps.handedOff(threadId)) return "it is handed off";
        if ((lastActivity(deps.records()).get(threadId) ?? Infinity) > candidate.since) return "it has a new message";
        return null;
      };
      if (still()) { deferred++; continue; }
      if (mtime(folder) > cutoff) continue;
      report.conversations.idle++;
      const keptNodeModules: string[] = [];
      const { trees, kept } = await deps.cleanup.idleInstalls(folder, threadId, pass, (path, why) => { because(why); if (path.endsWith(`${sep}node_modules`)) keptNodeModules.push(path); });
      if (kept) { (deps.log ?? console.log)(`idle reclaim: kept ${folder}: ${kept}`); because(kept); report.conversations.kept++; continue; }
      const going: FoundTree[] = [];
      for (const tree of trees) {
        const why = await extraHold(folder, tree);
        if (why) { (deps.log ?? console.log)(`idle reclaim: kept ${tree.path}: ${why}`); because(why); if (tree.path.endsWith(`${sep}node_modules`)) keptNodeModules.push(tree.path); }
        else going.push(tree);
      }
      // The folder's pnpm store goes only with every node_modules of the folder, which are hard links into it.
      // When the store stays, so do the pnpm installs: shedding only the links would free nothing and still cost a reinstall.
      const store = join(folder, PNPM_STORE);
      const storeStats = await lstat(store).catch(() => null);
      const pnpmStore = storeStats?.isDirectory() === true && (await names(store)).some((name) => /^v\d+$/.test(name) && isDir(join(store, name, "files")));
      if (pnpmStore && storeStats && !keptNodeModules.length && going.some((tree) => tree.path.endsWith(`${sep}node_modules`)) && mtime(store) <= cutoff &&
        openPaths && !openPaths.some((path) => inside(store, path))) {
        going.push({ path: store, dev: storeStats.dev, ino: storeStats.ino });
      } else if (pnpmStore) {
        for (let at = going.length - 1; at >= 0; at--) if (isFile(join(going[at]!.path, ".modules.yaml"))) going.splice(at, 1);
      }
      if (!going.length) { report.conversations.kept++; continue; }

      if (mode === "report") {
        let bytes = 0;
        for (const tree of going) bytes += await measure(tree.path);
        report.bytes += bytes;
        freedSoFar += bytes;
        report.folders += going.length;
        report.conversations.shed++;
        continue;
      }
      const moved: string[] = [];
      for (const tree of going) {
        const why = await deps.cleanup.retireIdle(folder, threadId, tree, pass, still);
        if (why) {
          if (why !== "it could not be moved safely") report.conversations.woke++;
          (deps.log ?? console.log)(`idle reclaim: kept ${tree.path}: ${why}`);
          if (why !== "it could not be moved safely") break;
          continue;
        }
        moved.push(relative(folder, tree.path));
        // Saved at once: a turn that starts before the pass ends still learns what is gone.
        notes[threadId] = { at: now, paths: [...moved] };
        try { updateState(dataDir, (saved) => { saved.notes[threadId] = notes[threadId]!; }); } catch (error) { warn(`idle reclaim: could not save the note for ${threadId}: ${message(error)}`); }
      }
      if (!moved.length) continue;
      report.folders += moved.length;
      report.conversations.shed++;
      await deps.cleanup.drain();
      const after = await volume(dataDir);
      if (after) freedSoFar = Math.max(freedSoFar, after.freeBytes - before.freeBytes);
    }
  } catch (error) {
    if (!(error instanceof OverBudget)) throw error;
    report.partial = true;
  }
  if (mode === "remove") {
    const after = await volume(dataDir);
    report.bytes = after ? Math.max(0, after.freeBytes - before.freeBytes) : freedSoFar;
    report.usedAfter = after ? usedShare(after) : null;
    if (after && usedShare(after) <= IDLE_RECLAIM.stopUsed) { reclaiming = false; report.reachedTarget = true; }
  } else {
    report.usedAfter = total > 0 ? Math.max(0, before.usedBytes - freedSoFar) / total : null;
    reclaiming = false;
  }
  return save(report, reclaiming, (saved) => {
    if (mode !== "remove") return;
    // Waiting only when nothing could go, not when a conversation was busy for now.
    if (report.folders === 0 && reclaiming && !deferred && !report.conversations.woke) { saved.quietUntil = now + IDLE_RECLAIM.quietMs; saved.quietAtUsed = usedBefore; }
    else { delete saved.quietUntil; delete saved.quietAtUsed; }
    saved.totals.folders += report.folders;
    saved.totals.conversations += report.conversations.shed;
    saved.totals.freedBytes += report.bytes;
  });
}

/** The first pass a quarter of an hour after start, then one every half hour; each reads the switch again. */
export function startIdleReclaim(deps: IdleReclaimDeps & { firstPassMs?: number; everyMs?: number }): void {
  let running = false;
  const pass = () => {
    if (running || deps.mode() === "off") return;
    running = true;
    void reclaimIdle(deps)
      .then((report) => { if (!report.skipped?.startsWith("below its budget")) (deps.log ?? console.log)(describeIdleReclaim(report)); })
      .catch((error: unknown) => (deps.warn ?? console.warn)(`idle reclaim: stopped: ${message(error)}`))
      .finally(() => { running = false; });
  };
  setTimeout(pass, deps.firstPassMs ?? IDLE_RECLAIM.firstPassMs).unref?.();
  setInterval(pass, deps.everyMs ?? IDLE_RECLAIM.everyMs).unref?.();
}
