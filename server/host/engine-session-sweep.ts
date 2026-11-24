// A Cloud home's engine session history: the Claude Code and Codex sessions MausBot itself started that no conversation
// can resume any more, and the Claude CLI's own MCP logs, go once they have been untouched for a week.
//
// The app resumes a conversation by its engine cursor alone (bots.json resumeCursors, through resume-plan.ts; a room
// keeps its session in memory for minutes): a session that is no conversation's cursor and no conversation's handed
// state is never resumed again. It is a session MausBot started when a session.started line in a remaining
// conversation's events log names it. A session no log names (the person's own, a bot's own `claude` run in a shell,
// one from before these logs) is never touched. A deleted conversation's sessions are delete-leftovers.ts's.
//
// Never removed: sign-in files, settings, `projects/<folder>/memory/` (only entries named by a whole session id are
// considered), anything reached through a link, or anything outside each engine's folder. Nothing is removed while any
// turn runs. An entry is first renamed, after a check that it is still the one listed (device and inode), into the
// app's own trash on the same volume (cache/trash, left out of backups), which is emptied at the end of the pass and on
// the next start after an interrupted one; an entry on another volume stays.
//
// Claude Code's own age sweep (cleanupPeriodDays) is made a deliberate 30 days in each of these Claude folders'
// existing settings.json, only where the person has not set it. It removes by age alone, live sessions too: a conversation idle
// longer goes on in a new session started from its chat, with a notice that earlier tool results did not carry over
// (drivers/claude.ts classifyResumeFailure, resume-recovery.ts). 30 is Claude Code's default, so nothing changes today;
// it stops a change of that default from changing what a Cloud keeps.
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, type FileHandle } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setImmediate as yieldNow, setTimeout as sleep } from "node:timers/promises";

import { writeFileAtomic } from "../atomic.ts";

import { plainlyUnder, type EngineSessionFolders } from "./delete-leftovers.ts";

export type EngineSessionSweepMode = "off" | "report" | "on";

const DAY_MS = 24 * 60 * 60_000;
/** A session file, or a CLI log, untouched this long. Far past a room's session idle and a warm fork moving a cursor. */
export const IDLE_MS = 7 * DAY_MS;
/** Soon after a start (a home that sleeps by stopping may be up only minutes), after the logs' sweep (3 minutes) and
 * the tool results' (5), so the three do not start at once. */
export const FIRST_PASS_MS = 7 * 60_000;
/** A pass that stopped for a turn, a move or a backup is tried again this soon. */
export const RETRY_MS = 30 * 60_000;
/** When the last whole pass ended, under the data folder's cache/ (left out of backups): a restart, which reads the
 * events logs again from their start, does not also bring the next pass forward. */
export const STAMP_FILE = join("cache", "engine-session-sweep.json");
/** Claude Code's transcript age limit for a Cloud's Claude folders (its default, made deliberate). */
export const CLAUDE_TRANSCRIPT_DAYS = 30;
/** While a turn runs nothing is removed: the pass waits this long for a quiet moment, then stops until the next. */
export const TURN_WAIT_MS = 10 * 60_000;
const TURN_POLL_MS = 15_000;
/** The app's own trash, under the data folder's cache (left out of backups and exports). */
export const TRASH_DIR = join("cache", "trash", "engine-sessions");
export const PASS_EVERY_MS = DAY_MS;
const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WHOLE_SESSION_ID = new RegExp(`^${SESSION_ID.source}$`, "i");
/** Claude Code 2.1: `projects/<folder>/<session>.jsonl` and its `<session>/` folder, and one entry per session in these. */
const CLAUDE_SESSION_FOLDERS = ["file-history", "session-env", "todos", "debug"] as const;
/** Codex: `sessions/<year>/<month>/<day>/rollout-<time>-<session>.jsonl`. */
const CODEX_SESSION_FOLDERS = ["sessions", "archived_sessions"] as const;
const CODEX_DEPTH = 6;
const CACHE_DEPTH = 4;
const LOG_NAME = /^[\w-]{1,128}\.ndjson$/;
const SESSION_MARK = Buffer.from('"session.started"');
const CHUNK = 1024 * 1024;
const MAX_LINE = 16 * 1024 * 1024;
const MEASURE_ENTRIES = 50_000;

/** OMB_ENGINE_SESSION_SWEEP: `report` (or `dry-run`) counts and changes nothing; `on` removes; anything else is off. */
export function engineSessionSweepMode(env: NodeJS.ProcessEnv): EngineSessionSweepMode {
  const raw = env.OMB_ENGINE_SESSION_SWEEP?.trim().toLowerCase();
  if (raw === "report" || raw === "dry-run") return "report";
  return raw === "on" ? "on" : "off";
}

type Cursors = Record<string, unknown> | undefined;
type Handed = Record<string, { session?: unknown } | undefined> | undefined;
export interface SessionHolder { resumeCursors?: Cursors; handedMessages?: Handed; tasks?: ReadonlyArray<{ resumeCursors?: Cursors; handedMessages?: Handed }> }

/** Every session a remaining conversation can resume: its cursors, and the sessions its handed state describes. */
export function liveSessions(bots: ReadonlyArray<SessionHolder>): Set<string> {
  const live = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value) live.add(value.toLowerCase());
  };
  for (const holder of [...bots, ...bots.flatMap((bot) => bot.tasks ?? [])]) {
    for (const cursor of Object.values(holder.resumeCursors ?? {})) add(cursor);
    for (const state of Object.values(holder.handedMessages ?? {})) add(state?.session);
  }
  return live;
}

/** The Claude CLI's own log folder for each environment an engine runs with (env-paths: XDG_CACHE_HOME, else ~/.cache). */
export function claudeCliCacheRoots(environments: Iterable<Record<string, string | undefined>>): string[] {
  const roots = new Set<string>();
  for (const env of environments) {
    const cache = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : env.HOME && isAbsolute(env.HOME) ? join(env.HOME, ".cache") : null;
    if (cache) roots.add(join(resolve(cache), "claude-cli-nodejs"));
  }
  return [...roots];
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function stat(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function realFolder(path: string): Promise<boolean> {
  return (await stat(path))?.isDirectory() === true;
}

/** Bytes under `path` and the newest change of anything in it (a directory's mtime misses a write to a file in it),
 * links counted as themselves and never followed; `whole` is false when the tree was past the budget or unreadable. */
async function measure(path: string): Promise<{ bytes: number; newest: number; whole: boolean }> {
  let bytes = 0;
  let newest = 0;
  let seen = 0;
  let whole = true;
  const walk = async (at: string) => {
    if (++seen > MEASURE_ENTRIES) {
      whole = false;
      return;
    }
    const stats = await stat(at);
    if (!stats) {
      whole = false;
      return;
    }
    bytes += stats.size;
    newest = Math.max(newest, stats.mtimeMs);
    if (stats.isDirectory()) for (const name of await entries(at)) await walk(join(at, name));
  };
  await walk(path);
  return { bytes, newest, whole };
}

/**
 * Session ids the conversations' events logs say MausBot started, read on from where the last pass stopped. A log
 * rewritten (a new inode, or shorter) is read again from its start.
 */
export function createLoggedSessions(eventsDir: string) {
  const read = new Map<string, { ino: number; size: number; ids: Set<string> }>();
  /** Reads [from, size) and returns where the last whole line ended: a line still being written is read whole next time. */
  async function scan(file: string, from: number, size: number, ids: Set<string>): Promise<number> {
    let handle: FileHandle;
    try {
      handle = await open(file, "r");
    } catch {
      return from;
    }
    let consumed = from;
    try {
      let carry = Buffer.alloc(0);
      const take = (line: Buffer) => {
        if (!line.includes(SESSION_MARK)) return;
        try {
          const event = JSON.parse(line.toString("utf8")) as { type?: unknown; sessionId?: unknown };
          if (event.type === "session.started" && typeof event.sessionId === "string" && WHOLE_SESSION_ID.test(event.sessionId)) ids.add(event.sessionId.toLowerCase());
        } catch {}
      };
      for (let position = from; position < size; position += CHUNK) {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK, size - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        let start = 0;
        for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, start)) {
          take(carry.length ? Buffer.concat([carry, chunk.subarray(start, at)]) : chunk.subarray(start, at));
          carry = Buffer.alloc(0);
          start = at + 1;
          consumed = position + start;
        }
        carry = Buffer.concat([carry, chunk.subarray(start)]);
        // One line this long is no session line; skip past it.
        if (carry.length > MAX_LINE) {
          carry = Buffer.alloc(0);
          consumed = position + chunk.length;
        }
      }
    } finally {
      await handle.close().catch(() => {});
    }
    return consumed;
  }
  return async function logged(): Promise<Set<string>> {
    const all = new Set<string>();
    if (!(await realFolder(eventsDir))) return all;
    const names = (await entries(eventsDir)).filter((name) => LOG_NAME.test(name));
    for (const name of read.keys()) if (!names.includes(name)) read.delete(name);
    for (const name of names) {
      const file = join(eventsDir, name);
      const stats = await stat(file);
      if (!stats?.isFile()) continue;
      let known = read.get(name);
      if (!known || known.ino !== stats.ino || stats.size < known.size) known = { ino: stats.ino, size: 0, ids: new Set() };
      if (stats.size > known.size) known.size = await scan(file, known.size, stats.size, known.ids);
      read.set(name, known);
      for (const id of known.ids) all.add(id);
      await yieldNow();
    }
    return all;
  };
}

interface Found { path: string; mtimeMs: number; dev: number; ino: number }

export interface EngineSessionSweepDeps {
  dataDir: string;
  mode: Exclude<EngineSessionSweepMode, "off">;
  folders: EngineSessionFolders;
  cacheRoots: readonly string[];
  /** Read at the start and again just before anything is removed. */
  live(): ReadonlySet<string>;
  logged: ReadonlySet<string>;
  paused?(): boolean;
  /** Any turn running anywhere on this server. */
  turnsRunning?(): boolean;
  turnWaitMs?: number;
  now?(): number;
}

/** True once nothing is paused and no turn runs; false when paused, or still busy after `waitMs`. */
async function quietMoment(deps: { paused?(): boolean; turnsRunning?(): boolean }, waitMs: number): Promise<boolean> {
  for (let waited = 0; ; waited += TURN_POLL_MS) {
    if (deps.paused?.()) return false;
    if (!deps.turnsRunning?.()) return true;
    if (waited >= waitMs) return false;
    await sleep(Math.min(TURN_POLL_MS, waitMs - waited), undefined, { ref: false });
  }
}

/** Empties the trash a pass (or an interrupted one) left; the folder itself must be a real one under the data folder. */
export async function emptyTrash(dataDir: string): Promise<void> {
  const trash = join(resolve(dataDir), TRASH_DIR);
  if (!(await realFolder(trash)) || !plainlyUnder(resolve(dataDir), trash)) return;
  for (const name of await entries(trash)) await rm(join(trash, name), { recursive: true, force: true }).catch(() => {});
}

/**
 * Claude Code's cleanupPeriodDays in a Claude folder's existing settings.json: added as CLAUDE_TRANSCRIPT_DAYS where the
 * file does not set it, keeping the file's mode, indentation and line endings. A folder without the file is left
 * without one ("absent"): Claude Code's default there is the same 30 days, so creating it would change nothing.
 */
export async function pinClaudeRetention(root: string, write: boolean, mayWrite: () => boolean = () => true): Promise<"set" | "kept" | "skipped" | "absent"> {
  const file = join(root, "settings.json");
  const stats = await stat(file);
  if (!stats) return "absent";
  if (!stats.isFile() || stats.size > 1024 * 1024) return "skipped";
  let text: string;
  let settings: Record<string, unknown>;
  try {
    text = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "skipped";
    settings = parsed as Record<string, unknown>;
  } catch {
    return "skipped";
  }
  if (Object.hasOwn(settings, "cleanupPeriodDays")) return "kept";
  if (!write) return "set";
  // The file's own layout: the indent of its first key (none when it is one line), its line ending, its last newline.
  const multiline = /\n\s*\S/.test(text.trim());
  const indent = multiline ? (/^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? 2) : undefined;
  let next = JSON.stringify({ ...settings, cleanupPeriodDays: CLAUDE_TRANSCRIPT_DAYS }, null, indent);
  if (text.includes("\r\n")) next = next.replace(/\n/g, "\r\n");
  if (/\r?\n$/.test(text)) next += text.endsWith("\r\n") ? "\r\n" : "\n";
  if (!mayWrite()) return "skipped";
  writeFileAtomic(file, next, { mode: stats.mode & 0o777 });
  return "set";
}

export interface EngineSessionSweepResult {
  mode: Exclude<EngineSessionSweepMode, "off">;
  /** Claude folders whose settings.json got cleanupPeriodDays, and those where the person's own value stays. */
  retentionSet: number;
  retentionKept: number;
  sessions: number;
  sessionBytes: number;
  cacheFiles: number;
  cacheBytes: number;
  kept: number;
  refused?: string;
  stopped: boolean;
}

/** A root an engine of this server uses: a real folder, and inside the data folder only by real folders. */
async function reachable(dataDir: string, root: string): Promise<boolean> {
  const inData = !relative(dataDir, resolve(root)).startsWith("..") && !isAbsolute(relative(dataDir, resolve(root)));
  return (await realFolder(root)) && (!inData || plainlyUnder(dataDir, root));
}

export async function sweepEngineSessions(deps: EngineSessionSweepDeps): Promise<EngineSessionSweepResult> {
  const now = deps.now?.() ?? Date.now();
  const write = deps.mode === "on";
  const dataDir = resolve(deps.dataDir);
  const result: EngineSessionSweepResult = { mode: deps.mode, retentionSet: 0, retentionKept: 0, sessions: 0, sessionBytes: 0, cacheFiles: 0, cacheBytes: 0, kept: 0, stopped: false };
  const live = deps.live();
  if (live.size === 0) return { ...result, refused: "no conversation has an engine session, so the records may not have loaded" };
  const dead = new Set([...deps.logged].filter((id) => !live.has(id)));
  for (const root of deps.folders.claude) {
    if (!(await reachable(dataDir, root))) continue;
    if (write && !(await quietMoment(deps, deps.turnWaitMs ?? TURN_WAIT_MS))) return { ...result, stopped: true };
    // The write itself only in a quiet moment, checked with no await before it.
    const pinned = await pinClaudeRetention(root, write, () => !deps.paused?.() && !deps.turnsRunning?.()).catch(() => "skipped" as const);
    if (pinned === "set") result.retentionSet++;
    else if (pinned === "kept") result.retentionKept++;
  }

  // Every entry named by a session id, under each root, with the session's newest change.
  const bySession = new Map<string, { entries: Array<{ root: string; path: string; dev: number; ino: number }>; newest: number }>();
  let liveFound = 0;
  const note = (root: string, found: Found, id: string) => {
    const session = bySession.get(id) ?? { entries: [], newest: 0 };
    session.entries.push({ root, path: found.path, dev: found.dev, ino: found.ino });
    session.newest = Math.max(session.newest, found.mtimeMs);
    bySession.set(id, session);
  };
  const idOf = (name: string) => SESSION_ID.exec(name)?.[0]?.toLowerCase();
  for (const root of deps.folders.claude) {
    if (!(await reachable(dataDir, root))) continue;
    const projects = join(root, "projects");
    const folders = (await realFolder(projects)) ? (await entries(projects)).map((folder) => join(projects, folder)) : [];
    for (const dir of [...folders, ...CLAUDE_SESSION_FOLDERS.map((folder) => join(root, folder))]) {
      if (!(await realFolder(dir))) continue;
      for (const name of await entries(dir)) {
        const id = idOf(name);
        if (!id) continue;
        if (live.has(id)) liveFound++;
        if (!dead.has(id)) continue;
        const stats = await stat(join(dir, name));
        if (stats) note(root, { path: join(dir, name), mtimeMs: stats.mtimeMs, dev: stats.dev, ino: stats.ino }, id);
      }
      await yieldNow();
    }
  }
  for (const root of deps.folders.codex) {
    if (!(await reachable(dataDir, root))) continue;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > CODEX_DEPTH) return;
      for (const name of await entries(dir)) {
        const path = join(dir, name);
        const stats = await stat(path);
        if (!stats) continue;
        if (stats.isDirectory()) {
          await walk(path, depth + 1);
          continue;
        }
        const id = idOf(name);
        if (!id) continue;
        if (live.has(id)) liveFound++;
        if (dead.has(id)) note(root, { path, mtimeMs: stats.mtimeMs, dev: stats.dev, ino: stats.ino }, id);
      }
      await yieldNow();
    };
    for (const folder of CODEX_SESSION_FOLDERS) if (await realFolder(join(root, folder))) await walk(join(root, folder), 0);
  }
  if (bySession.size > 0 && liveFound === 0) {
    return { ...result, refused: "none of the conversations' own sessions were found where this looks, so it removed nothing" };
  }

  const trash = join(dataDir, TRASH_DIR, String(now));
  let trashReady = false;
  let moved = 0;
  /** Renames an entry into the trash: only the one listed, only on the trash's volume. */
  const discard = async (root: string, path: string, listed: { dev: number; ino: number }): Promise<boolean> => {
    if (!trashReady) {
      await mkdir(trash, { recursive: true, mode: 0o700 });
      if (!(await realFolder(trash)) || !plainlyUnder(dataDir, trash)) return false;
      trashReady = true;
    }
    const current = await stat(path);
    const trashStats = await stat(trash);
    if (!current || current.dev !== listed.dev || current.ino !== listed.ino || !trashStats || trashStats.dev !== current.dev || !plainlyUnder(root, path)) return false;
    // A turn, a move or a backup that began during the checks above: nothing more goes in this pass.
    if (deps.paused?.() || deps.turnsRunning?.()) {
      result.stopped = true;
      return false;
    }
    return rename(path, join(trash, `${moved++}`)).then(() => true, () => false);
  };
  for (const [id, session] of bySession) {
    if (now - session.newest < IDLE_MS || deps.live().has(id)) {
      result.kept++;
      continue;
    }
    if (!(await quietMoment(deps, deps.turnWaitMs ?? TURN_WAIT_MS))) {
      result.stopped = true;
      break;
    }
    // Every entry, all the way down, a week idle and readable, or the whole session stays.
    const sizes: number[] = [];
    let fresh = false;
    for (const entry of session.entries) {
      const measured = await measure(entry.path);
      if (!measured.whole || now - measured.newest < IDLE_MS) fresh = true;
      sizes.push(measured.bytes);
    }
    if (fresh) {
      result.kept++;
      continue;
    }
    let bytes = 0;
    let gone = 0;
    for (const [index, entry] of session.entries.entries()) {
      if (!plainlyUnder(entry.root, entry.path)) continue;
      if (write && !(await discard(entry.root, entry.path, entry))) {
        if (result.stopped) break;
        continue;
      }
      bytes += sizes[index]!;
      gone++;
    }
    if (gone) {
      result.sessions++;
      result.sessionBytes += bytes;
    }
    if (result.stopped) break;
  }
  if (trashReady) await rm(trash, { recursive: true, force: true }).catch(() => {});
  if (result.stopped) return result;

  for (const root of deps.cacheRoots) {
    if (!(await reachable(dataDir, root))) continue;
    const walk = async (dir: string, depth: number): Promise<boolean> => {
      let empty = true;
      for (const name of await entries(dir)) {
        if (deps.paused?.()) {
          result.stopped = true;
          return false;
        }
        const path = join(dir, name);
        const stats = await stat(path);
        if (!stats) continue;
        if (stats.isDirectory() && depth < CACHE_DEPTH) {
          const cleared = await walk(path, depth + 1);
          // An empty folder only, by rmdir: one that got a file meanwhile stays.
          if (!(cleared && now - stats.mtimeMs >= IDLE_MS && plainlyUnder(root, path) && (!write || (await rmdir(path).then(() => true, () => false))))) empty = false;
          continue;
        }
        if (stats.isFile() && now - stats.mtimeMs >= IDLE_MS && plainlyUnder(root, path)) {
          if (!(await quietMoment(deps, deps.turnWaitMs ?? TURN_WAIT_MS))) {
            result.stopped = true;
            return false;
          }
          // A log file in the CLI's own log folder: removed in place, the one listed only.
          const current = await stat(path);
          if (write && !(current?.isFile() && current.ino === stats.ino && (await rm(path, { force: true }).then(() => true, () => false)))) {
            empty = false;
            continue;
          }
          result.cacheFiles++;
          result.cacheBytes += stats.size;
          continue;
        }
        empty = false;
      }
      await yieldNow();
      return empty;
    };
    await walk(root, 0);
    if (result.stopped) return result;
  }
  return result;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function sweepLine(result: EngineSessionSweepResult): string {
  if (result.refused) return `[engine-sessions] ${result.mode}: ${result.refused}`;
  const verb = result.mode === "report" ? "would free" : "freed";
  return `[engine-sessions] ${result.mode}: Claude transcript age ${CLAUDE_TRANSCRIPT_DAYS} days ${result.mode === "report" ? "would be " : ""}set in ${result.retentionSet} folders (already set in ${result.retentionKept}); ${result.sessions} ended sessions (${mb(result.sessionBytes)}) and ${result.cacheFiles} CLI log files `
    + `(${mb(result.cacheBytes)}); ${verb} ${mb(result.sessionBytes + result.cacheBytes)}; ${result.kept} ended sessions kept until a week idle`
    + (result.stopped ? " (stopped for a move, a backup or a running turn; the next pass carries on)" : "");
}

export interface StartEngineSessionSweepDeps {
  cloudHome: boolean;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  bots(): ReadonlyArray<SessionHolder>;
  folders(): EngineSessionFolders;
  environments(): Iterable<Record<string, string | undefined>>;
  paused?(): boolean;
  turnsRunning?(): boolean;
  log?(line: string): void;
}

export interface EngineSessionPassDeps {
  dataDir: string;
  mode: Exclude<EngineSessionSweepMode, "off">;
  folders(): EngineSessionFolders;
  cacheRoots(): readonly string[];
  live(): ReadonlySet<string>;
  logged(): Promise<Set<string>>;
  paused?(): boolean;
  turnsRunning?(): boolean;
  turnWaitMs?: number;
  now?(): number;
}

/**
 * One pass, or null when it did nothing: during a move freeze or a backup, or while turns kept running. Nothing is
 * read or written before that check; then, in `on` mode only, an interrupted pass's trash is emptied (it is already
 * out of every engine's reach) and the sweep runs.
 */
export async function engineSessionPass(deps: EngineSessionPassDeps): Promise<EngineSessionSweepResult | null> {
  if (deps.paused?.()) return null;
  if (!(await quietMoment(deps, deps.turnWaitMs ?? TURN_WAIT_MS))) return null;
  if (deps.mode === "on") await emptyTrash(deps.dataDir);
  return sweepEngineSessions({
    dataDir: deps.dataDir, mode: deps.mode, folders: deps.folders(), cacheRoots: deps.cacheRoots(), live: deps.live,
    logged: await deps.logged(), paused: deps.paused, turnsRunning: deps.turnsRunning, turnWaitMs: deps.turnWaitMs, now: deps.now,
  });
}

/** Cloud homes only, and only with OMB_ENGINE_SESSION_SWEEP set: a pass when due, at the earliest FIRST_PASS_MS after start. */
export function startEngineSessionSweep(deps: StartEngineSessionSweepDeps): boolean {
  const mode = engineSessionSweepMode(deps.env);
  if (!deps.cloudHome || mode === "off") return false;
  const log = deps.log ?? ((line: string) => console.log(line));
  const logged = createLoggedSessions(join(resolve(deps.dataDir), "events"));
  const pass = async (): Promise<boolean> => {
    try {
      const result = await engineSessionPass({
        dataDir: deps.dataDir, mode, folders: deps.folders, cacheRoots: () => claudeCliCacheRoots(deps.environments()),
        live: () => liveSessions(deps.bots()), logged, paused: deps.paused, turnsRunning: deps.turnsRunning,
      });
      if (!result) return false;
      if (result.refused || result.sessions || result.cacheFiles || result.retentionSet || result.stopped) log(sweepLine(result));
      return !result.stopped;
    } catch (error) {
      log(`[engine-sessions] pass failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  schedulePasses(join(deps.dataDir, STAMP_FILE), PASS_EVERY_MS, pass);
  return true;
}

/**
 * Runs `pass` FIRST_PASS_MS after start, or later when the last whole pass (saved in `stamp`) is not yet `every` old,
 * then every `every`; a pass that stopped early is tried again after RETRY_MS. A stamp from the future (a clock set
 * back) counts as none, and a home that slept past its time runs one pass on waking, never one per missed interval.
 */
export function schedulePasses(stamp: string, every: number, pass: () => Promise<boolean>, now: () => number = Date.now): void {
  const run = async () => {
    const whole = await pass();
    if (whole) {
      try {
        mkdirSync(dirname(stamp), { recursive: true, mode: 0o700 });
        writeFileSync(stamp, JSON.stringify({ at: now() }), { mode: 0o600 });
      } catch {}
    }
    setTimeout(() => void run(), whole ? every : RETRY_MS).unref();
  };
  // The stamp is read in the first timer, never while the server is still starting.
  const first = () => {
    let last: number | null = null;
    try {
      const at = (JSON.parse(readFileSync(stamp, "utf8")) as { at?: unknown }).at;
      if (typeof at === "number" && Number.isFinite(at) && at <= now()) last = at;
    } catch {}
    const wait = last === null ? 0 : last + every - now();
    if (wait > 0) setTimeout(() => void run(), wait).unref();
    else void run();
  };
  setTimeout(first, FIRST_PASS_MS).unref();
}
