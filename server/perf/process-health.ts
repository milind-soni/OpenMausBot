// How close this server is to the limits on what it may run, for the next report of "out of processes": what process 1 is,
// the container's limits, how many processes, threads, zombies and open files there are now and at their most, and how
// often turns had to wait or a spawn was refused. Privacy invariant: numbers and the fixed words below only. Never a
// command line, an argument, a path, a name or anything a bot or a person wrote.
import { boxMemory } from "../box-memory.ts";
import { CHAT_RUNTIME_KINDS, ENGINE_PROCESS_KINDS, engineMemory } from "../engine-memory.ts";
import { openDescriptors, readCgroupMemory, readCgroupPeaks, readProcessLimits, type ProcessLimits, type Unknown } from "../process-limits.ts";
import { processBudget, type ProcessCounts } from "../process-room.ts";
import type { ProcessBucket, ProcessRow } from "./process-buckets.ts";

export const PROCESS_HEALTH_DOCS = 'docs/self-hosting.md, "Running on a container platform"';
/** Above this many zombies nothing is collecting them: a few come and go between a process's exit and its parent's wait. */
const ZOMBIES_WORTH_SAYING = 20;
const NEAR_LIMIT = 0.8;
const ENGINES_SHOWN = 8;
const MB = 1024 * 1024;

type Count = number | Unknown;
export interface ProcessTally {
  procs: number;
  /** Unknown where the process list carries no thread counts or states (macOS's `ps` columns). */
  threads: Count;
  zombies: Count;
  /** This server's own open file descriptors. */
  fds: Count;
  /** What the container's pids limit counts now: processes and threads. */
  pidsUsed: Count;
  /** Engine processes by engine kind, a fixed list's words. */
  engines: Record<string, number>;
  browser: number;
  mcp: number;
  shell: number;
  other: number;
}

export interface ProcessHealth {
  pid1: ProcessLimits["pid1"];
  reaper: ProcessLimits["reaper"];
  serverIsPid1: boolean;
  limits: { pids: number | "max" | Unknown; memMB: number | "none" | Unknown; nproc: number | "unlimited" | Unknown; shmMB: Count; gate: number | "none" };
  now: ProcessTally | Unknown;
  /** The most of each since start, from the sampler's lists (a minute apart on Linux). */
  peak: ProcessTally | Unknown;
  /** The kernel's own most since the container started: exact, where cgroup v2 keeps it. */
  kernelPeak: { pids: Count; memMB: Count };
  turns: { running: number; queued: number; longestWaitS: number; most: number | "none" };
  since: { queued: number; starved: number; spawnFailed: ProcessCounts["spawnFailed"]; forceKilled: number; lateReaped: number };
}

const KNOWN_ENGINES: ReadonlySet<string> = new Set([...ENGINE_PROCESS_KINDS, ...CHAT_RUNTIME_KINDS, "unknown"]);

/** One sample's rows as counts. A row outside every bucket (not started by this server, or adopted by an init) is "other". */
export function tally(rows: readonly ProcessRow[], buckets: ReadonlyMap<number, ProcessBucket>, fds: Count, pidsUsed: Count): ProcessTally {
  const out: ProcessTally = { procs: rows.length, threads: 0, zombies: 0, fds, pidsUsed, engines: {}, browser: 0, mcp: 0, shell: 0, other: 0 };
  let threads = 0, zombies = 0, detailed = rows.length > 0;
  for (const row of rows) {
    if (row.threads === undefined || row.state === undefined) detailed = false;
    threads += row.threads ?? 0;
    if (row.state === "Z") zombies += 1;
    const bucket = buckets.get(row.pid);
    if (bucket === "server") continue;
    if (bucket?.startsWith("engine:")) {
      const kind = bucket.slice("engine:".length), name = KNOWN_ENGINES.has(kind) ? kind : "unknown";
      if (Object.hasOwn(out.engines, name) || Object.keys(out.engines).length < ENGINES_SHOWN) out.engines[name] = (out.engines[name] ?? 0) + 1;
    } else if (bucket === "browser") out.browser += 1;
    else if (bucket === "mcp") out.mcp += 1;
    else if (bucket === "commands" || bucket === "build") out.shell += 1;
    else out.other += 1;
  }
  out.threads = detailed ? threads : "unknown";
  out.zombies = detailed ? zombies : "unknown";
  return out;
}

const higher = (a: Count, b: Count): Count => (a === "unknown" ? b : b === "unknown" ? a : Math.max(a, b));

function peakOf(peak: ProcessTally | null, now: ProcessTally): ProcessTally {
  if (!peak) return { ...now, engines: { ...now.engines } };
  const engines = { ...peak.engines };
  for (const [kind, count] of Object.entries(now.engines)) engines[kind] = Math.max(engines[kind] ?? 0, count);
  return { procs: Math.max(peak.procs, now.procs), threads: higher(peak.threads, now.threads), zombies: higher(peak.zombies, now.zombies), fds: higher(peak.fds, now.fds),
    pidsUsed: higher(peak.pidsUsed, now.pidsUsed), engines, browser: Math.max(peak.browser, now.browser), mcp: Math.max(peak.mcp, now.mcp),
    shell: Math.max(peak.shell, now.shell), other: Math.max(peak.other, now.other) };
}

export interface ProcessHealthDeps {
  limits?: () => ProcessLimits;
  memoryLimitBytes?: () => number | null;
  /** What counts against the container's memory limit now; null where none is set or readable. */
  memoryUsedBytes?: () => number | null;
  peaks?: () => { pids: number | null; memoryBytes: number | null };
  fds?: () => Count;
  turns?: () => { running: number; queued: number; longestWaitMs: number; most: number | null; queuedEver: number; starvedEver: number };
  counts?: () => ProcessCounts;
  platform?: NodeJS.Platform;
  pid?: number;
  /** One line at most per kind; the caller limits how often. */
  warn?: (kind: string, line: string) => void;
}

const words = (value: number | string, unit = "") => (typeof value === "number" ? `${value}${unit}` : value);

export function limitsLine(health: Pick<ProcessHealth, "pid1" | "reaper" | "limits">): string {
  const first = health.pid1 === "init" ? "an init" : health.pid1 === "node" ? (health.reaper === "yes" ? "this app, with an init beneath it" : "this app, with no init") : health.pid1 === "other" ? "another program" : "unknown";
  return `process 1 is ${first}; limits: processes and threads ${words(health.limits.pids)}, memory ${words(health.limits.memMB, " MB")}, ulimit -u ${words(health.limits.nproc)}, /dev/shm ${words(health.limits.shmMB, " MB")}`;
}

export function createProcessHealth(deps: ProcessHealthDeps = {}) {
  const platform = deps.platform ?? process.platform;
  const limits = deps.limits ?? (() => readProcessLimits({ platform }));
  const memoryLimit = deps.memoryLimitBytes ?? (() => boxMemory().cgroupLimit);
  const memoryUsed = deps.memoryUsedBytes ?? (() => (platform === "linux" ? readCgroupMemory()?.usedBytes ?? null : null));
  const peaks = deps.peaks ?? (() => (platform === "linux" ? readCgroupPeaks() : { pids: null, memoryBytes: null }));
  const fds = deps.fds ?? (() => (platform === "linux" ? openDescriptors() : "unknown"));
  const turns = deps.turns ?? (() => engineMemory.counts());
  const counts = deps.counts ?? (() => processBudget.counts());
  let now: ProcessTally | null = null, peak: ProcessTally | null = null;
  const told = new Set<string>();

  const report = (): ProcessHealth => {
    const read = limits(), turn = turns(), count = counts(), memory = platform === "linux" ? memoryLimit() : undefined, kernel = peaks();
    return {
      pid1: read.pid1, reaper: read.reaper, serverIsPid1: (deps.pid ?? process.pid) === 1,
      limits: { pids: read.pidsMax, memMB: memory === undefined ? "unknown" : memory === null ? "none" : Math.round(memory / MB), nproc: read.nproc,
        shmMB: read.shmBytes === "unknown" ? "unknown" : Math.round(read.shmBytes / MB), gate: count.limit ?? "none" },
      now: now ?? "unknown", peak: peak ?? "unknown",
      kernelPeak: { pids: kernel.pids ?? "unknown", memMB: kernel.memoryBytes === null ? "unknown" : Math.round(kernel.memoryBytes / MB) },
      turns: { running: turn.running, queued: turn.queued, longestWaitS: Math.round(turn.longestWaitMs / 1000), most: turn.most ?? "none" },
      since: { queued: turn.queuedEver, starved: turn.starvedEver, spawnFailed: count.spawnFailed, forceKilled: count.forceKilled, lateReaped: count.lateReaped },
    };
  };

  return {
    /** After each of the sampler's process lists: nothing here on a platform that has none. */
    sample(rows: readonly ProcessRow[], buckets: ReadonlyMap<number, ProcessBucket>): void {
      const read = limits();
      now = tally(rows, buckets, fds(), read.pidsCurrent);
      peak = peakOf(peak, now);
      const limit = counts().limit ?? (typeof read.pidsMax === "number" ? read.pidsMax : null);
      if (limit !== null && typeof now.pidsUsed === "number" && now.pidsUsed >= limit * NEAR_LIMIT && !told.has("near")) {
        told.add("near");
        deps.warn?.("processes:near", `this server runs ${now.pidsUsed} processes and threads of the ${limit} its container allows (${now.zombies === "unknown" ? "?" : now.zombies} of them zombies). Past the limit nothing new can start; turns wait for room before that. See ${PROCESS_HEALTH_DOCS}.`);
      }
      const memLimit = platform === "linux" ? memoryLimit() : null, used = memLimit === null ? null : memoryUsed();
      if (memLimit !== null && used !== null && used >= memLimit * NEAR_LIMIT && !told.has("memory")) {
        told.add("memory");
        deps.warn?.("processes:memory", `this server uses ${Math.round(used / MB)} MB of the ${Math.round(memLimit / MB)} MB its container allows. Past the limit the kernel stops an engine; turns wait for room before that. See ${PROCESS_HEALTH_DOCS}.`);
      }
      if (typeof now.zombies === "number" && now.zombies > ZOMBIES_WORTH_SAYING && !told.has("zombies")) {
        told.add("zombies");
        deps.warn?.("processes:zombies", `${now.zombies} exited processes are waiting to be collected and nothing collects them: this container has no init as process 1. They count against its process limit until it restarts. See ${PROCESS_HEALTH_DOCS}.`);
      }
    },
    report,
    startLine: () => `processes: ${limitsLine(report())}`,
  };
}
export type ProcessHealthRecorder = ReturnType<typeof createProcessHealth>;

const tallyLine = (count: ProcessTally) =>
  `${count.procs} processes, ${words(count.threads)} threads, ${words(count.zombies)} zombies, ${words(count.fds)} open files, ${words(count.pidsUsed)} against the limit; `
  + `engines ${Object.entries(count.engines).map(([kind, n]) => `${kind} ${n}`).join(", ") || "none"}, browser ${count.browser}, tool servers ${count.mcp}, commands ${count.shell}, other ${count.other}`;

/** The same for people: a @devs report and the diagnostics text. */
export function processHealthLines(health: ProcessHealth): string[] {
  const failed = Object.entries(health.since.spawnFailed).filter(([, n]) => n > 0).map(([code, n]) => `${code} ${n}`).join(", ") || "none";
  return [
    `Process room: ${limitsLine(health)}; new engines kept below ${words(health.limits.gate)} processes and threads`,
    `  Now: ${health.now === "unknown" ? "unknown (no process list on this system)" : tallyLine(health.now)}`,
    `  Most since start (sampled): ${health.peak === "unknown" ? "unknown" : tallyLine(health.peak)}`,
    `  Most since start (kernel): ${words(health.kernelPeak.pids)} processes and threads, ${words(health.kernelPeak.memMB, " MB")} memory`,
    `  Turns: ${health.turns.running} running, ${health.turns.queued} waiting for room (longest ${health.turns.longestWaitS}s), at most ${words(health.turns.most)} at once`,
    `  Since start: ${health.since.queued} waited for room; spawns refused: ${failed}; engines that never came up: ${health.since.starved}; force-stopped: ${health.since.forceKilled}; outlived their turn: ${health.since.lateReaped}`,
  ];
}

/** Without its most-since-start counts and with at most four engine kinds: what is dropped first when the report must shrink. */
export function trimmedProcessHealth(health: ProcessHealth): ProcessHealth {
  const fewer = (count: ProcessTally | Unknown) => (count === "unknown" ? count : { ...count, engines: Object.fromEntries(Object.entries(count.engines).slice(0, 4)) });
  return { ...health, now: fewer(health.now), peak: "unknown" };
}
