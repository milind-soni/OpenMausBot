// The stall watch's own thread (perf/stall-watch.ts). It reads the main thread's heartbeat every second; once the main thread
// has not beaten for `thresholdMs` it records where that thread is, while it is still stuck: a short CPU profile of the
// main thread through the inspector (answered between two JavaScript instructions, so a loop or a long regex shows its
// code), else the thread's state and wait channel from /proc (a system call, a page fault); with the machine's memory and
// CPU pressure and the memory each kind of process holds. The record goes to the data folder and to stderr at once,
// synchronously from this thread, so a server that is then restarted still leaves it behind.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { workerData } from "node:worker_threads";

import { classifyProcesses } from "./perf/process-buckets.ts";
import { linuxProcessList } from "./perf/process-sampler.ts";
import { availableMB, pressure10, stallLine, stealPercent, summarizeProfile, threadState, type CpuProfile, type StallRecord } from "./perf/stall-sample.ts";

interface WatchData { beat: SharedArrayBuffer; dataDir: string; file: string; thresholdMs: number; repeatMs: number; profileMs: number; answerMs: number; keep: number; perStall: number }
const data = workerData as WatchData;
const beat = new BigInt64Array(data.beat);
const read = (path: string): string | null => { try { return readFileSync(path, "utf8"); } catch { return null; } };
const MB = 1_048_576;

function within<T>(promise: Promise<T>, ms: number): Promise<T | "late"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("late"), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve("late"); });
  });
}

/** A profile of the main thread for `profileMs`, or null when it did not answer within `answerMs` (it is not running
 * JavaScript) or this Node has no inspector. */
async function profileMain(): Promise<CpuProfile | null> {
  type MainSession = { connectToMainThread(): void; post(method: string, params?: object): Promise<unknown>; disconnect(): void };
  let opened: MainSession | null = null;
  try {
    const { Session } = await import("node:inspector/promises");
    const session = new Session() as unknown as MainSession;
    opened = session;
    session.connectToMainThread();
    if (await within(session.post("Profiler.enable"), data.answerMs) === "late") return null;
    await within(session.post("Profiler.setSamplingInterval", { interval: 1000 }), data.answerMs);
    if (await within(session.post("Profiler.start"), data.answerMs) === "late") return null;
    await new Promise((resolve) => setTimeout(resolve, data.profileMs));
    const stopped = await within(session.post("Profiler.stop") as Promise<{ profile: CpuProfile }>, data.answerMs);
    return stopped === "late" ? null : stopped.profile;
  } catch {
    return null;
  } finally {
    try { opened?.disconnect(); } catch {}
  }
}

function memoryByKind(): StallRecord["memory"] {
  if (process.platform !== "linux") return [];
  try {
    const { rows } = linuxProcessList();
    const buckets = classifyProcesses(rows, process.pid, false);
    const sums = new Map<string, { rss: number; procs: number }>();
    for (const row of rows) {
      const bucket = buckets.get(row.pid) ?? "other";
      const sum = sums.get(bucket) ?? { rss: 0, procs: 0 };
      sum.rss += row.rssBytes;
      sum.procs += 1;
      sums.set(bucket, sum);
    }
    return [...sums].map(([bucket, sum]) => ({ bucket: bucket as StallRecord["memory"][number]["bucket"], rssMB: Math.round(sum.rss / MB), procs: sum.procs }))
      .sort((a, b) => b.rssMB - a.rssMB).slice(0, 8);
  } catch {
    return [];
  }
}

function save(record: StallRecord): void {
  try {
    let records: StallRecord[] = [];
    try { const kept = JSON.parse(readFileSync(data.file, "utf8")) as { records?: StallRecord[] }; records = Array.isArray(kept.records) ? kept.records : []; } catch {}
    records = [...records, record].slice(-data.keep);
    const tmp = join(data.dataDir, `.perf-stalls.${process.pid}.tmp`);
    // Written and flushed through one descriptor (Windows flushes only a file open for writing); a flush that fails still
    // leaves the record, as a crash before it would.
    const fd = openSync(tmp, "w");
    try { writeFileSync(fd, JSON.stringify({ v: 1, records })); try { fsyncSync(fd); } catch {} } finally { closeSync(fd); }
    renameSync(tmp, data.file);
  } catch {}
  // Straight to the descriptor: a worker's console goes through the main thread, which is stuck.
  try { writeSync(2, `[perf] ${stallLine(record)}\n`); } catch {}
}

async function take(blockedSinceMs: number): Promise<void> {
  const statBefore = read("/proc/stat");
  const self = `/proc/${process.pid}/task/${process.pid}`;
  const thread = threadState(read(`${self}/stat`), read(`${self}/wchan`));
  const profile = await profileMain();
  const statAfter = read("/proc/stat");
  const summary = profile ? summarizeProfile(profile) : null;
  const record: StallRecord = {
    at: Date.now(), blockedSinceMs, kind: summary ? "js" : "outside-js", top: summary?.top ?? [], stack: summary?.stack ?? [], thread,
    machine: { availableMB: availableMB(read("/proc/meminfo")), memoryFull10: pressure10(read("/proc/pressure/memory"), "full"), cpuSome10: pressure10(read("/proc/pressure/cpu"), "some"),
      stealPct: stealPercent(statBefore, statAfter) },
    memory: memoryByKind(),
  };
  save(record);
}

let lastTick = performance.now(), busy = false, taken = 0, lastTakenAt = 0, stuck = false;
setInterval(() => {
  const now = performance.now(), late = now - lastTick - 1000;
  lastTick = now;
  const age = Date.now() - Number(Atomics.load(beat, 0));
  // This thread ran late for most of the heartbeat's age: the whole process was paused (a computer asleep) or starved of
  // CPU, not its main thread stuck. Looked at again on the next tick, which a main thread that runs will have beaten by.
  if (late > 1500 && late > age / 2) return;
  if (age < data.thresholdMs) { stuck = false; taken = 0; return; }
  if (busy || taken >= data.perStall || (stuck && Date.now() - lastTakenAt < data.repeatMs)) return;
  stuck = true;
  busy = true;
  taken += 1;
  lastTakenAt = Date.now();
  void take(age).finally(() => { busy = false; });
}, 1000);
