// A Cloud home's conversation logs (events/ and native/, one file per conversation) get a total cap and an age limit.
//
// What reads them: the Inspector (thread-events.ts readThreadEvents, the newest lines within MAX_TAIL_BYTES), a bot's
// Activity panel (activity.ts, the newest EVENTS_PER_THREAD events of each conversation), the sentinel's turn records
// (sentinel/sources.ts, read on from an offset and safe across a rename), and delete leftovers (delete-leftovers.ts
// loggedSessions, every session.started line, to find a deleted conversation's engine sessions). What the person reads
// as the conversation is messages.db, and a conversation resumes from its engine cursor in bots.json: neither is here.
//
// So a log is cut, never a conversation: an idle log keeps the newest lines those panels read (READ_FLOOR) and, for
// events, every session.started line from the part cut away. Only when the folders are still over the cap after
// that are the logs of conversations idle for a week cut to those session lines (events) or removed (native).
// Never a log written to in the last day, a conversation with a turn running or handed off, or one this server does
// not know (a deleted conversation's log is its delete's to remove). Nothing changes while any turn runs. Only plain
// files inside events/ and native/ are rewritten or removed; nothing follows a link; every swap re-checks the file
// just before the rename.
import { lstatSync, renameSync, rmSync, statfsSync } from "node:fs";
import { open, lstat, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldNow, setTimeout as sleep } from "node:timers/promises";

import { EVENTS_PER_THREAD } from "../activity.ts";
import { MAX_TAIL_BYTES } from "../thread-events.ts";

export type ThreadLogSweepMode = "off" | "report" | "on";

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60_000;
/** The newest lines the Inspector and the Activity panel read; kept in every trimmed log. */
export const READ_FLOOR = { lines: EVENTS_PER_THREAD, bytes: MAX_TAIL_BYTES } as const;
/** A log written to within this long is left alone: its conversation may be mid-turn or about to be. */
export const QUIET_MS = DAY_MS;
/** An idle log older than this is trimmed to READ_FLOOR whether or not the folders are over the cap. */
export const AGE_MS = 30 * DAY_MS;
/** Over the cap after trimming, logs idle this long are cut to their session lines, least recently written first. */
export const CUT_AFTER_MS = 7 * DAY_MS;
/** A log smaller than this is never worth a trim. */
export const MIN_TRIM_BYTES = 1024 * 1024;
export const MIN_CAP_BYTES = 2 * GIB;
export const CAP_SHARE = 0.03;
const SESSION_LINES_MAX = 1_000;
const SESSION_BYTES_MAX = 1024 * 1024;
const CHUNK = 1024 * 1024;
const MAX_CARRY = 16 * 1024 * 1024;
const SESSION_MARK = Buffer.from('"session.started"');
const LOG_NAME = /^([\w-]{1,128})\.ndjson$/;
export const FIRST_PASS_MS = 15 * 60_000;
/** While a turn runs nothing is changed: the pass waits this long for a quiet moment, then stops until the next. */
export const TURN_WAIT_MS = 10 * 60_000;
const TURN_POLL_MS = 15_000;
export const PASS_EVERY_MS = 6 * 60 * 60_000;

/** OMB_THREAD_LOG_SWEEP: `report` (or `dry-run`) counts and changes nothing; `on` trims; anything else is off. */
export function threadLogSweepMode(env: NodeJS.ProcessEnv): ThreadLogSweepMode {
  const raw = env.OMB_THREAD_LOG_SWEEP?.trim().toLowerCase();
  if (raw === "report" || raw === "dry-run") return "report";
  return raw === "on" || raw === "1" || raw === "true" ? "on" : "off";
}

/** Bytes, or a number with K, M or G (powers of 1024); null for anything else. */
export function parseBytes(raw: string | undefined): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([KMG]?)i?B?$/i.exec(raw?.trim() ?? "");
  if (!match) return null;
  const bytes = Math.floor(Number(match[1]) * 1024 ** "_KMG".indexOf(match[2]!.toUpperCase() || "_"));
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

/** OMB_THREAD_LOG_CAP when set, else the larger of 2 GiB and 3% of the volume. */
export function threadLogCap(env: NodeJS.ProcessEnv, volumeBytes: number | null): number {
  return parseBytes(env.OMB_THREAD_LOG_CAP) ?? Math.max(MIN_CAP_BYTES, Math.floor(CAP_SHARE * (volumeBytes ?? 0)));
}

function volumeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return stats.blocks * stats.bsize;
  } catch {
    return null;
  }
}

export interface ThreadState { busy: boolean }

/** Every conversation this server keeps, by thread id: each bot's and each room's. A room's busy is not tracked here;
 * QUIET_MS keeps a room mid-turn out of reach. */
export function knownThreads(
  bots: ReadonlyArray<{ id: string; threadId?: string; tasks?: ReadonlyArray<{ threadId: string }> }>,
  groups: ReadonlyArray<{ threadId?: string; tasks?: ReadonlyArray<{ threadId: string }> }>,
  busy: (botId: string, threadId: string) => boolean,
): Map<string, ThreadState> {
  const threads = new Map<string, ThreadState>();
  const add = (threadId: string | undefined, isBusy: boolean) => {
    if (!threadId) return;
    threads.set(threadId, { busy: isBusy || threads.get(threadId)?.busy === true });
  };
  for (const bot of bots) for (const threadId of [bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]) add(threadId, Boolean(threadId) && busy(bot.id, threadId!));
  for (const group of groups) for (const threadId of [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]) add(threadId, false);
  return threads;
}

export interface LogFile {
  kind: "events" | "native";
  path: string;
  threadId: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

export async function listLogs(dataDir: string): Promise<LogFile[]> {
  const files: LogFile[] = [];
  for (const kind of ["events", "native"] as const) {
    const dir = join(dataDir, kind);
    try {
      if (!(await lstat(dir)).isDirectory()) continue;
    } catch {
      continue;
    }
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    let seen = 0;
    for (const name of names) {
      const threadId = LOG_NAME.exec(name)?.[1];
      if (!threadId) continue;
      const path = join(dir, name);
      try {
        const stats = await lstat(path);
        if (stats.isFile()) files.push({ kind, path, threadId, size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino });
      } catch {}
      if (++seen % 200 === 0) await yieldNow();
    }
  }
  return files;
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** Where the newest `floor` begins: 0 when the whole file fits, else just after a newline. */
async function tailStart(handle: FileHandle, size: number, floor: { lines: number; bytes: number }): Promise<number> {
  let best = size;
  let lines = 0;
  let end = size - 1;
  while (end > 0) {
    const start = Math.max(0, end - CHUNK);
    const chunk = await readAt(handle, start, end - start);
    for (let i = chunk.length - 1; i >= 0; i--) {
      if (chunk[i] !== 0x0a) continue;
      const candidate = start + i + 1;
      if (size - candidate > floor.bytes) return best;
      best = candidate;
      if (++lines >= floor.lines) return best;
    }
    end = start;
  }
  return size <= floor.bytes ? 0 : best;
}

/** The session.started lines of [0, end), newest kept when there are more than the bound. */
async function sessionLines(handle: FileHandle, end: number): Promise<Buffer[]> {
  const kept: Buffer[] = [];
  let keptBytes = 0;
  let carry = Buffer.alloc(0);
  const take = (line: Buffer) => {
    if (!line.includes(SESSION_MARK)) return;
    try {
      const event = JSON.parse(line.toString("utf8")) as { type?: unknown; sessionId?: unknown };
      if (event.type !== "session.started" || typeof event.sessionId !== "string") return;
    } catch {
      return;
    }
    kept.push(Buffer.concat([line, Buffer.from("\n")]));
    keptBytes += line.length + 1;
    while (kept.length > SESSION_LINES_MAX || keptBytes > SESSION_BYTES_MAX) keptBytes -= kept.shift()!.length;
  };
  for (let position = 0; position < end; position += CHUNK) {
    const chunk = await readAt(handle, position, Math.min(CHUNK, end - position));
    if (chunk.length === 0) break;
    let from = 0;
    for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, from)) {
      take(carry.length ? Buffer.concat([carry, chunk.subarray(from, at)]) : chunk.subarray(from, at));
      carry = Buffer.alloc(0);
      from = at + 1;
    }
    carry = Buffer.concat([carry, chunk.subarray(from)]);
    if (carry.length > MAX_CARRY) carry = Buffer.alloc(0);
  }
  if (carry.length) take(carry);
  return kept;
}

const unchanged = (file: LogFile): boolean => {
  try {
    const now = lstatSync(file.path);
    return now.isFile() && now.ino === file.ino && now.size === file.size && now.mtimeMs === file.mtimeMs;
  } catch {
    return false;
  }
};

/**
 * Keeps `floor` of the log's newest lines (none when null) and, for events, its session.started lines from the part
 * cut away. Returns the bytes freed, or would free when `write` is false. A file that changed since it was listed, or
 * whose kept part is empty and `floor` is not null, is left as it is.
 */
export async function trimLog(file: LogFile, floor: { lines: number; bytes: number } | null, write: boolean): Promise<number> {
  let handle: FileHandle;
  try {
    handle = await open(file.path, "r");
  } catch {
    return 0;
  }
  const staging = `${file.path}.sweep`;
  let swapped = false;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.ino !== file.ino || stats.size !== file.size) return 0;
    const start = floor ? await tailStart(handle, file.size, floor) : file.size;
    // Nothing to cut, or a newest line past the floor's bytes: a trim would keep none of what the panels read.
    if (start === 0 || (floor && start === file.size)) return 0;
    const sessions = file.kind === "events" ? await sessionLines(handle, start) : [];
    const keptBytes = sessions.reduce((sum, line) => sum + line.length, 0) + (file.size - start);
    const freed = file.size - keptBytes;
    if (freed <= 0) return 0;
    if (!write) return freed;
    if (keptBytes === 0) {
      if (!unchanged(file)) return 0;
      rmSync(file.path, { force: true });
      return freed;
    }
    rmSync(staging, { force: true });
    const target = await open(staging, "wx", 0o600);
    try {
      for (const line of sessions) await target.write(line);
      for (let position = start; position < file.size; position += CHUNK) {
        const chunk = await readAt(handle, position, Math.min(CHUNK, file.size - position));
        if (chunk.length === 0) throw new Error("the log shrank while it was copied");
        await target.write(chunk);
      }
      // The log keeps its last write time: it is how old the conversation's activity is, for this sweep's next pass too.
      await target.utimes(stats.atime, stats.mtime);
    } finally {
      await target.close();
    }
    // No await from here to the rename: an append that landed while the copy ran is noticed, and the log kept.
    if (!unchanged(file)) return 0;
    renameSync(staging, file.path);
    swapped = true;
    return freed;
  } catch {
    return 0;
  } finally {
    await handle.close().catch(() => {});
    if (!swapped) rmSync(staging, { force: true });
  }
}

export interface ThreadLogSweepDeps {
  dataDir: string;
  mode: Exclude<ThreadLogSweepMode, "off">;
  cap: number;
  threads(): ReadonlyMap<string, ThreadState>;
  /** A move freeze or a backup under way: the pass stops before its next file. */
  paused?(): boolean;
  /** Any turn running anywhere on this server: the pass waits up to `turnWaitMs` before each change, then stops. */
  turnsRunning?(): boolean;
  turnWaitMs?: number;
  now?(): number;
}

/** True once nothing is paused and no turn runs; false when paused, or still busy after `waitMs`. */
export async function quietMoment(deps: { paused?(): boolean; turnsRunning?(): boolean }, waitMs: number): Promise<boolean> {
  for (let waited = 0; ; waited += TURN_POLL_MS) {
    if (deps.paused?.()) return false;
    if (!deps.turnsRunning?.()) return true;
    if (waited >= waitMs) return false;
    await sleep(Math.min(TURN_POLL_MS, waitMs - waited), undefined, { ref: false });
  }
}

export interface ThreadLogSweepResult {
  mode: Exclude<ThreadLogSweepMode, "off">;
  cap: number;
  before: number;
  after: number;
  files: number;
  trimmed: number;
  cut: number;
  stopped: boolean;
}

export async function sweepThreadLogs(deps: ThreadLogSweepDeps): Promise<ThreadLogSweepResult> {
  const now = deps.now?.() ?? Date.now();
  const write = deps.mode === "on";
  const files = await listLogs(deps.dataDir);
  const threads = deps.threads();
  const before = files.reduce((sum, file) => sum + file.size, 0);
  const result: ThreadLogSweepResult = { mode: deps.mode, cap: deps.cap, before, after: before, files: files.length, trimmed: 0, cut: 0, stopped: false };
  const idle = (file: LogFile) => {
    const thread = threads.get(file.threadId);
    return thread !== undefined && !thread.busy && now - file.mtimeMs >= QUIET_MS;
  };
  /** What each trim freed (or would): a report counts a later cut of the same log net of it. */
  const freedBy = new Map<LogFile, number>();
  const apply = async (file: LogFile, floor: typeof READ_FLOOR | null): Promise<boolean> => {
    if (!(await quietMoment(deps, deps.turnWaitMs ?? TURN_WAIT_MS))) {
      result.stopped = true;
      return false;
    }
    // A busy flag read now, not at the start of the pass.
    if (deps.threads().get(file.threadId)?.busy) return true;
    const earlier = freedBy.get(file) ?? 0;
    // A log trimmed in this pass is listed again, so its cut sees what the trim left.
    const target = earlier && write ? await relisted(file) : file;
    if (!target) return true;
    const freed = (await trimLog(target, floor, write)) - (write ? 0 : earlier);
    if (freed > 0) {
      result.after -= freed;
      freedBy.set(file, earlier + freed);
      if (floor) result.trimmed++;
      else result.cut++;
    }
    return true;
  };
  const oldestFirst = (a: LogFile, b: LogFile) => a.mtimeMs - b.mtimeMs;
  const candidates = files.filter(idle).sort(oldestFirst);
  for (const file of candidates) {
    if (now - file.mtimeMs < AGE_MS || file.size < MIN_TRIM_BYTES) continue;
    if (!(await apply(file, READ_FLOOR))) return result;
  }
  for (const file of candidates) {
    if (result.after <= deps.cap) return result;
    if (freedBy.has(file) || file.size < MIN_TRIM_BYTES) continue;
    if (!(await apply(file, READ_FLOOR))) return result;
  }
  for (const file of candidates) {
    if (result.after <= deps.cap) return result;
    if (now - file.mtimeMs < CUT_AFTER_MS) continue;
    if (!(await apply(file, null))) return result;
  }
  return result;
}

async function relisted(file: LogFile): Promise<LogFile | null> {
  try {
    const stats = await lstat(file.path);
    return stats.isFile() ? { ...file, size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino } : null;
  } catch {
    return null;
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function sweepLine(result: ThreadLogSweepResult): string {
  const freed = result.before - result.after;
  const verb = result.mode === "report" ? "would free" : "freed";
  return `[thread-logs] ${result.mode}: ${result.files} logs, ${mb(result.before)} against a cap of ${mb(result.cap)}; `
    + `${result.trimmed} trimmed to their newest lines, ${result.cut} cut to their session lines; ${verb} ${mb(freed)}`
    + (result.stopped ? " (stopped for a move, a backup or a running turn; the next pass carries on)" : "");
}

export interface StartThreadLogSweepDeps {
  cloudHome: boolean;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  threads(): ReadonlyMap<string, ThreadState>;
  paused?(): boolean;
  turnsRunning?(): boolean;
  log?(line: string): void;
}

/** Cloud homes only, and only with OMB_THREAD_LOG_SWEEP set: a pass FIRST_PASS_MS after start, then every PASS_EVERY_MS. */
export function startThreadLogSweep(deps: StartThreadLogSweepDeps): boolean {
  const mode = threadLogSweepMode(deps.env);
  if (!deps.cloudHome || mode === "off") return false;
  const log = deps.log ?? ((line: string) => console.log(line));
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const cap = threadLogCap(deps.env, volumeBytes(deps.dataDir));
      const result = await sweepThreadLogs({ dataDir: deps.dataDir, mode, cap, threads: deps.threads, paused: deps.paused, turnsRunning: deps.turnsRunning });
      if (result.before !== result.after || result.before > cap || result.stopped) log(sweepLine(result));
    } catch (error) {
      log(`[thread-logs] pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void pass(), FIRST_PASS_MS).unref();
  setInterval(() => void pass(), PASS_EVERY_MS).unref();
  return true;
}
