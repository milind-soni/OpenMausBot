// The stall watch: when the server's main thread has not run for STALL_RECORD_MS, a thread of its own records where it is
// and what the machine looks like, while it is still stuck (stall-watch.worker.ts). A Cloud home that stops answering is
// restarted, and its log keeps only its last lines, so each record is written to the data folder (STALL_FILE) at once and
// read back here: the next start logs the last ones, and a @devs report shows them. The main thread's part is a heartbeat
// twice a second, a store of the time in shared memory.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { stallLine, type StallRecord } from "./stall-sample.ts";

export const STALL_FILE = "perf-stalls.json";
/** A main thread stuck this long is recorded: the Admin's health check gives up on a home after 10 s. */
export const STALL_RECORD_MS = 10_000;
/** While it stays stuck, recorded again this often, at most PER_STALL times; at most RECORDS_PER_HOUR records and
 * PROFILES_PER_HOUR profiles in any hour, across stalls. */
const REPEAT_MS = 60_000, PER_STALL = 5, KEEP = 20, RECORDS_PER_HOUR = 30, PROFILES_PER_HOUR = 5;
/** A profile costs the main thread tens of MB while it runs: taken only with this much memory available and the memory
 * stall (full avg10, percent) at most this; otherwise the record has no profile. */
const PROFILE_FLOOR_MB = 150, PROFILE_STALL_MAX = 5;
/** How long the profile runs, and how long the main thread has to answer each inspector call before it is taken as not
 * running JavaScript. */
const PROFILE_MS = 2_000, ANSWER_MS = 5_000;
const HEARTBEAT_MS = 500;
/** Records this recent are logged when the server starts: the ones a restart cut off. */
const SHOW_AT_START_MS = 24 * 3_600_000;

export interface StallWatch {
  stop(): void;
  /** The newest records, newest last. */
  recent(limit?: number): StallRecord[];
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown) => (typeof value === "string" ? value : null);
/** A kept record with every field it should have, or null: a file from another version, or edited, never throws later. */
function wellFormed(raw: unknown): StallRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>, at = num(record.at);
  if (at === null) return null;
  const kind = record.kind === "js" || record.kind === "outside-js" ? record.kind : "not-profiled";
  const thread = (record.thread ?? {}) as Record<string, unknown>, machine = (record.machine ?? {}) as Record<string, unknown>;
  const why = ["memory", "hourly-cap", "no-inspector", "pending"].includes(record.why as string) ? record.why as StallRecord["why"] : undefined;
  return {
    at, blockedSinceMs: num(record.blockedSinceMs) ?? 0, kind, ...(kind === "not-profiled" ? { why: why ?? "pending" } : {}),
    top: Array.isArray(record.top) ? record.top.flatMap((frame: { at?: unknown; samples?: unknown }) => str(frame?.at) !== null ? [{ at: frame.at as string, samples: num(frame.samples) ?? 0 }] : []) : [],
    stack: Array.isArray(record.stack) ? record.stack.filter((frame): frame is string => typeof frame === "string") : [],
    thread: { state: str(thread.state), wchan: str(thread.wchan) },
    machine: { availableMB: num(machine.availableMB), memoryFull10: num(machine.memoryFull10), cpuSome10: num(machine.cpuSome10), stealPct: num(machine.stealPct) },
    memory: Array.isArray(record.memory) ? record.memory.flatMap((entry: { bucket?: unknown; rssMB?: unknown; procs?: unknown }) =>
      str(entry?.bucket) !== null ? [{ bucket: entry.bucket as StallRecord["memory"][number]["bucket"], rssMB: num(entry.rssMB) ?? 0, procs: num(entry.procs) ?? 0 }] : []) : [],
  };
}

/** The records kept in the data folder, oldest first; none when the file is missing or unreadable. */
export function readStallRecords(file: string): StallRecord[] {
  try {
    const kept = JSON.parse(readFileSync(file, "utf8")) as { records?: unknown };
    return Array.isArray(kept.records) ? kept.records.flatMap((record) => wellFormed(record) ?? []) : [];
  } catch {
    return [];
  }
}

/** The report's lines: the newest records, newest last. */
export function stallReportLines(records: readonly StallRecord[]): string[] {
  if (!records.length) return [];
  return ["Main thread stalls caught (newest last):", ...records.map((record) => `${new Date(record.at).toISOString()} ${stallLine(record)}`)];
}

/** The app's own folder: the parent of `server/` from the source, of `dist-server/` from the bundle. */
function appRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return /[\\/]perf$/.test(here) ? dirname(dirname(here)) : dirname(here);
}

function workerUrl(): URL | null {
  // From the source (server/perf/), the bundle (dist-server/index.js), or a compiled copy beside this file's folder.
  for (const candidate of ["../stall-watch.worker.ts", "./stall-watch.worker.js", "../stall-watch.worker.js"]) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(url)) return url;
  }
  return null;
}

export interface StallWatchOptions {
  dataDir: string;
  log?: (line: string) => void;
  /** Tests: a shorter threshold and profile, another memory floor for a profile. */
  thresholdMs?: number;
  profileMs?: number;
  profileFloorMB?: number;
  now?: () => number;
}

/** Starts the watch; null where its thread can't start (it never stops the server from starting). */
export function startStallWatch(options: StallWatchOptions): StallWatch | null {
  const file = join(options.dataDir, STALL_FILE), now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const earlier = readStallRecords(file).filter((record) => now() - record.at <= SHOW_AT_START_MS).slice(-3);
  for (const record of earlier) { try { log(`[perf] stall before this start, ${new Date(record.at).toISOString()}: ${stallLine(record)}`); } catch {} }
  const url = workerUrl();
  if (!url) return null;
  // The monotonic clock, the same in every thread of the process: a change of the wall clock is never a stall.
  const shared = new SharedArrayBuffer(8), beat = new BigInt64Array(shared);
  const pulse = () => Atomics.store(beat, 0, process.hrtime.bigint() / 1_000_000n);
  pulse();
  const heart = setInterval(pulse, HEARTBEAT_MS);
  heart.unref?.();
  let worker: Worker;
  try {
    worker = new Worker(url, {
      workerData: { beat: shared, dataDir: options.dataDir, file, appRoot: appRoot(), thresholdMs: options.thresholdMs ?? STALL_RECORD_MS, repeatMs: REPEAT_MS,
        profileMs: options.profileMs ?? PROFILE_MS, answerMs: ANSWER_MS, keep: KEEP, perStall: PER_STALL, recordsPerHour: RECORDS_PER_HOUR, profilesPerHour: PROFILES_PER_HOUR,
        profileFloorMB: options.profileFloorMB ?? PROFILE_FLOOR_MB, profileStallMax: PROFILE_STALL_MAX },
      // No test loaders or inspector ports of the parent; a small heap of its own.
      execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
  } catch {
    clearInterval(heart);
    return null;
  }
  worker.unref();
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; clearInterval(heart); void worker.terminate().catch(() => undefined); };
  worker.on("error", (error) => { log(`[perf] the stall watch stopped: ${error instanceof Error ? error.name : "error"}`); stop(); });
  return { stop, recent: (limit = 5) => readStallRecords(file).slice(-limit) };
}
