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
// considered), anything reached through a link, or anything outside each engine's folder. Claude Code's own age sweep
// (cleanupPeriodDays, 30 days by default) is left as it is: it removes by age alone, live sessions too, so a shorter
// one would end conversations' sessions that this sweep keeps.
import { lstat, open, readdir, rm, rmdir, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setImmediate as yieldNow } from "node:timers/promises";

import { plainlyUnder, type EngineSessionFolders } from "./delete-leftovers.ts";

export type EngineSessionSweepMode = "off" | "report" | "on";

const DAY_MS = 24 * 60 * 60_000;
/** A session file, or a CLI log, untouched this long. Far past a room's session idle and a warm fork moving a cursor. */
export const IDLE_MS = 7 * DAY_MS;
export const FIRST_PASS_MS = 30 * 60_000;
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
  return raw === "on" || raw === "1" || raw === "true" ? "on" : "off";
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

/** Bytes under `path`, links counted as themselves and never followed; a tree past the budget counts what was seen. */
async function measure(path: string): Promise<number> {
  let bytes = 0;
  let seen = 0;
  const walk = async (at: string) => {
    if (++seen > MEASURE_ENTRIES) return;
    const stats = await stat(at);
    if (!stats) return;
    bytes += stats.size;
    if (stats.isDirectory()) for (const name of await entries(at)) await walk(join(at, name));
  };
  await walk(path);
  return bytes;
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

interface Found { path: string; mtimeMs: number }

export interface EngineSessionSweepDeps {
  dataDir: string;
  mode: Exclude<EngineSessionSweepMode, "off">;
  folders: EngineSessionFolders;
  cacheRoots: readonly string[];
  /** Read at the start and again just before anything is removed. */
  live(): ReadonlySet<string>;
  logged: ReadonlySet<string>;
  paused?(): boolean;
  now?(): number;
}

export interface EngineSessionSweepResult {
  mode: Exclude<EngineSessionSweepMode, "off">;
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
  const result: EngineSessionSweepResult = { mode: deps.mode, sessions: 0, sessionBytes: 0, cacheFiles: 0, cacheBytes: 0, kept: 0, stopped: false };
  const live = deps.live();
  if (live.size === 0) return { ...result, refused: "no conversation has an engine session, so the records may not have loaded" };
  const dead = new Set([...deps.logged].filter((id) => !live.has(id)));

  // Every entry named by a session id, under each root, with the session's newest change.
  const bySession = new Map<string, { entries: Array<{ root: string; path: string }>; newest: number }>();
  let liveFound = 0;
  const note = (root: string, found: Found, id: string) => {
    const session = bySession.get(id) ?? { entries: [], newest: 0 };
    session.entries.push({ root, path: found.path });
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
        if (stats) note(root, { path: join(dir, name), mtimeMs: stats.mtimeMs }, id);
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
        if (dead.has(id)) note(root, { path, mtimeMs: stats.mtimeMs }, id);
      }
      await yieldNow();
    };
    for (const folder of CODEX_SESSION_FOLDERS) if (await realFolder(join(root, folder))) await walk(join(root, folder), 0);
  }
  if (bySession.size > 0 && liveFound === 0) {
    return { ...result, refused: "none of the conversations' own sessions were found where this looks, so it removed nothing" };
  }

  const stillLive = deps.live();
  for (const [id, session] of bySession) {
    if (now - session.newest < IDLE_MS || stillLive.has(id)) {
      result.kept++;
      continue;
    }
    if (deps.paused?.()) return { ...result, stopped: true };
    let bytes = 0;
    for (const entry of session.entries) {
      if (!plainlyUnder(entry.root, entry.path)) continue;
      bytes += await measure(entry.path);
      if (write) await rm(entry.path, { recursive: true, force: true }).catch(() => {});
    }
    result.sessions++;
    result.sessionBytes += bytes;
  }

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
          result.cacheFiles++;
          result.cacheBytes += stats.size;
          if (write) await rm(path, { force: true }).catch(() => {});
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
  return `[engine-sessions] ${result.mode}: ${result.sessions} ended sessions (${mb(result.sessionBytes)}) and ${result.cacheFiles} CLI log files `
    + `(${mb(result.cacheBytes)}); ${verb} ${mb(result.sessionBytes + result.cacheBytes)}; ${result.kept} ended sessions kept until a week idle`
    + (result.stopped ? " (stopped for a move or backup; the next pass carries on)" : "");
}

export interface StartEngineSessionSweepDeps {
  cloudHome: boolean;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  bots(): ReadonlyArray<SessionHolder>;
  folders(): EngineSessionFolders;
  environments(): Iterable<Record<string, string | undefined>>;
  paused?(): boolean;
  log?(line: string): void;
}

/** Cloud homes only, and only with OMB_ENGINE_SESSION_SWEEP set: a pass FIRST_PASS_MS after start, then daily. */
export function startEngineSessionSweep(deps: StartEngineSessionSweepDeps): boolean {
  const mode = engineSessionSweepMode(deps.env);
  if (!deps.cloudHome || mode === "off") return false;
  const log = deps.log ?? ((line: string) => console.log(line));
  const logged = createLoggedSessions(join(resolve(deps.dataDir), "events"));
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const result = await sweepEngineSessions({
        dataDir: deps.dataDir, mode, folders: deps.folders(), cacheRoots: claudeCliCacheRoots(deps.environments()),
        live: () => liveSessions(deps.bots()), logged: await logged(), paused: deps.paused,
      });
      if (result.refused || result.sessions || result.cacheFiles || result.stopped) log(sweepLine(result));
    } catch (error) {
      log(`[engine-sessions] pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void pass(), FIRST_PASS_MS).unref();
  setInterval(() => void pass(), PASS_EVERY_MS).unref();
  return true;
}
