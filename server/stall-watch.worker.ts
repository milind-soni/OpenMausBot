// The stall watch's own thread (perf/stall-watch.ts). It reads the main thread's heartbeat every second (perf/stall-ticker.ts
// decides when to record). Once the main thread has not beaten for `thresholdMs` it records, while that thread is still
// stuck, what costs nothing first: the thread's state and wait channel from /proc (a system call, a page fault), the
// memory available to this server and the memory and CPU stall, the memory each kind of process holds; that record goes to
// the data folder and to stderr at once. Only then, and only with memory to spare (a profile costs the main thread tens of
// MB, which on a thrashing home could bring the OOM killer), a short CPU profile of the main thread through the inspector
// (answered between two JavaScript instructions, so a loop or a long regex shows its code) completes the record.
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { workerData } from "node:worker_threads";

import { classifyProcesses } from "./perf/process-buckets.ts";
import { linuxProcessList } from "./perf/process-sampler.ts";
import { availableMB, pressure10, stallLine, stealPercent, summarizeProfile, threadState, type CpuProfile, type StallRecord } from "./perf/stall-sample.ts";
import { createStallTicker } from "./perf/stall-ticker.ts";

interface WatchData {
  beat: SharedArrayBuffer; dataDir: string; file: string; appRoot: string; thresholdMs: number; repeatMs: number; profileMs: number; answerMs: number; keep: number;
  perStall: number; recordsPerHour: number; profilesPerHour: number; profileFloorMB: number; profileStallMax: number;
}
const data = workerData as WatchData;
const beat = new BigInt64Array(data.beat);
const read = (path: string): string | null => { try { return readFileSync(path, "utf8"); } catch { return null; } };
const MB = 1_048_576;
const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);
const tmpPrefix = ".perf-stalls.";

function within<T>(promise: Promise<T>, ms: number): Promise<T | "late"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("late"), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve("late"); });
  });
}

/** A profile of the main thread for `profileMs`; "late" when it did not answer within `answerMs` (it is not running
 * JavaScript), "unavailable" when this Node has no inspector. */
async function profileMain(): Promise<CpuProfile | "late" | "unavailable"> {
  type MainSession = { connectToMainThread(): void; post(method: string, params?: object): Promise<unknown>; disconnect(): void };
  let opened: MainSession | null = null;
  try {
    let Session: new () => MainSession;
    try { Session = (await import("node:inspector/promises")).Session as unknown as new () => MainSession; } catch { return "unavailable"; }
    const session = new Session();
    opened = session;
    try { session.connectToMainThread(); } catch { return "unavailable"; }
    if (await within(session.post("Profiler.enable"), data.answerMs) === "late") return "late";
    await within(session.post("Profiler.setSamplingInterval", { interval: 1000 }), data.answerMs);
    if (await within(session.post("Profiler.start"), data.answerMs) === "late") return "late";
    await new Promise((resolve) => setTimeout(resolve, data.profileMs));
    const stopped = await within(session.post("Profiler.stop") as Promise<{ profile: CpuProfile }>, data.answerMs);
    return stopped === "late" ? "late" : stopped.profile;
  } catch {
    return "late";
  } finally {
    try { opened?.disconnect(); } catch {}
  }
}

/** Memory available to this server: within its cgroup's limit where it has one (libuv), else the machine's. */
function availableToServer(): number | null {
  try { const bytes = process.availableMemory?.(); if (typeof bytes === "number" && bytes > 0) return Math.round(bytes / MB); } catch {}
  return availableMB(read("/proc/meminfo"));
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

/** Saved in place of an earlier record taken at the same moment (a record completed by its profile), else appended. */
function save(record: StallRecord): void {
  const tmp = join(data.dataDir, `${tmpPrefix}${process.pid}.tmp`);
  try {
    let records: StallRecord[] = [];
    try { const kept = JSON.parse(readFileSync(data.file, "utf8")) as { records?: StallRecord[] }; records = Array.isArray(kept.records) ? kept.records : []; } catch {}
    records = [...records.filter((kept) => kept?.at !== record.at), record].slice(-data.keep);
    // Written and flushed through one descriptor (Windows flushes only a file open for writing); a flush that fails still
    // leaves the record, as a crash before it would.
    const fd = openSync(tmp, "w");
    try { writeFileSync(fd, JSON.stringify({ v: 1, records })); try { fsyncSync(fd); } catch {} } finally { closeSync(fd); }
    renameSync(tmp, data.file);
  } catch {
    try { unlinkSync(tmp); } catch {}
  }
  // Straight to the descriptor: a worker's console goes through the main thread, which is stuck.
  try { writeSync(2, `[perf] ${stallLine(record)}\n`); } catch {}
}

async function take(blockedSinceMs: number, mayProfile: () => boolean): Promise<void> {
  const statBefore = read("/proc/stat");
  const self = `/proc/${process.pid}/task/${process.pid}`;
  const machine: StallRecord["machine"] = { availableMB: availableToServer(), memoryFull10: pressure10(read("/proc/pressure/memory"), "full"),
    cpuSome10: pressure10(read("/proc/pressure/cpu"), "some"), stealPct: null };
  const light: StallRecord = { at: Date.now(), blockedSinceMs, kind: "not-profiled", why: "pending", top: [], stack: [], thread: threadState(read(`${self}/stat`), read(`${self}/wchan`)),
    machine, memory: memoryByKind() };
  const roomy = (machine.availableMB ?? 0) >= data.profileFloorMB && (machine.memoryFull10 ?? 0) <= data.profileStallMax;
  const why: StallRecord["why"] = !roomy ? "memory" : mayProfile() ? undefined : "hourly-cap";
  if (why) light.why = why;
  save(light);
  if (why) return;
  const profile = await profileMain();
  const summary = typeof profile === "object" ? summarizeProfile(profile, data.appRoot) : null;
  const done: StallRecord = { ...light, ...(summary ? { kind: "js" as const, top: summary.top, stack: summary.stack } : profile === "late" ? { kind: "outside-js" as const } : { why: "no-inspector" as const }),
    machine: { ...machine, stealPct: stealPercent(statBefore, read("/proc/stat")) } };
  if (done.kind !== "not-profiled") delete done.why;
  save(done);
}

// A temporary file a stopped process left behind.
try { for (const name of readdirSync(data.dataDir)) if (name.startsWith(tmpPrefix) && name.endsWith(".tmp")) try { unlinkSync(join(data.dataDir, name)); } catch {} } catch {}

const ticker = createStallTicker({ thresholdMs: data.thresholdMs, repeatMs: data.repeatMs, perStall: data.perStall, recordsPerHour: data.recordsPerHour, profilesPerHour: data.profilesPerHour });
let busy = false;
setInterval(() => {
  const now = monotonicMs(), beatAt = Number(Atomics.load(beat, 0));
  if (!ticker.tick(now, beatAt) || busy) return;
  busy = true;
  void take(ticker.age(now, beatAt), () => ticker.mayProfile(monotonicMs())).finally(() => { busy = false; });
}, 1000);
