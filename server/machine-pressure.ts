// Whether this machine is too busy right now for work that can wait, read from the signals the server already keeps:
// the memory stall (engine-memory.ts), the CPU's pressure, steal and cgroup throttling (the files stall-watch reads), and
// the event loop's longest recent delay (perf/loop-stalls.ts). Only where turns wait for room (a Cloud home, a self-hosted
// Linux server: engine-memory's gate); the desktop app and any machine without /proc never read as pressed.
import { availableParallelism } from "node:os";
import { readFileSync } from "node:fs";

import { engineMemory, readHostMemory, type HostMemory } from "./engine-memory.ts";
import { recentLoopDelayMs } from "./perf/loop-stalls.ts";
import { pressure10 } from "./perf/stall-sample.ts";

/** Every runnable task waited on memory this much of the last ten seconds (`full avg10`, percent): a 2 GB Cloud whose
 * engine status checks timed out showed about 10%. */
export const MEMORY_STALL_PERCENT = 5;
/** Some task waited for a CPU this much of the last ten seconds (`some avg10`, percent). */
export const CPU_STALL_PERCENT = 50;
/** Of the CPU time between two reads, this much went to another machine (steal) or was held back by the cgroup's quota. */
export const HELD_BACK_PERCENT = 25;
/** The event loop could not answer for this long in the last minute or two. */
export const LOOP_DELAY_MS = 2_000;
/** A reading answers later questions this long. */
export const PRESSURE_READ_MS = 5_000;
/** At or under this much memory, or this few CPUs, the machine is small: one engine status check runs at a time. */
export const SMALL_MEMORY_BYTES = 4 * 1024 ** 3;
export const SMALL_CPUS = 2;

type Read = (path: string) => string | null;
const readText: Read = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };

export interface PressureSources {
  enabled?: () => boolean;
  read?: Read;
  memory?: () => HostMemory | null;
  loopDelayMs?: () => number | null;
  now?: () => number;
  cpus?: () => number;
}

/** `/proc/stat`'s first line: all CPU time and the stolen part, in ticks. */
function cpuTicks(text: string | null): { total: number; steal: number } | null {
  const fields = text ? /^cpu\s+([\d\s]+)$/m.exec(text)?.[1]?.trim().split(/\s+/).map(Number) : undefined;
  if (!fields || fields.length < 8 || fields.some((value) => !Number.isFinite(value))) return null;
  return { total: fields.slice(0, 8).reduce((sum, value) => sum + value, 0), steal: fields[7]! };
}

/** cgroup v2's `cpu.stat` throttled time, microseconds. */
const throttledUs = (text: string | null): number | null => {
  const found = text ? /^throttled_usec (\d+)$/m.exec(text) : null;
  return found ? Number(found[1]) : null;
};

export function createMachinePressure(sources: PressureSources = {}) {
  const enabled = sources.enabled ?? (() => engineMemory.enabled && process.platform === "linux");
  const read = sources.read ?? readText;
  const memory = sources.memory ?? (() => readHostMemory());
  const loopDelayMs = sources.loopDelayMs ?? recentLoopDelayMs;
  const now = sources.now ?? Date.now;
  const cpus = sources.cpus ?? availableParallelism;
  let last: { at: number; why: string | null } | null = null;
  let counters: { at: number; ticks: { total: number; steal: number } | null; throttled: number | null } | null = null;

  const why = (): string | null => {
    const host = memory();
    if ((host?.fullStall10 ?? 0) >= MEMORY_STALL_PERCENT) return `memory stall ${host!.fullStall10}%`;
    const cpu = pressure10(read("/sys/fs/cgroup/cpu.pressure") ?? read("/proc/pressure/cpu"), "some");
    if ((cpu ?? 0) >= CPU_STALL_PERCENT) return `cpu stall ${cpu}%`;
    const at = now(), ticks = cpuTicks(read("/proc/stat")), throttled = throttledUs(read("/sys/fs/cgroup/cpu.stat"));
    const before = counters;
    counters = { at, ticks, throttled };
    if (before && at > before.at) {
      if (before.ticks && ticks && ticks.total > before.ticks.total) {
        const steal = ((ticks.steal - before.ticks.steal) / (ticks.total - before.ticks.total)) * 100;
        if (steal >= HELD_BACK_PERCENT) return `cpu steal ${Math.round(steal)}%`;
      }
      if (before.throttled !== null && throttled !== null && throttled >= before.throttled) {
        const share = ((throttled - before.throttled) / 1000 / (at - before.at)) * 100;
        if (share >= HELD_BACK_PERCENT) return `cpu throttled ${Math.round(share)}%`;
      }
    }
    const delay = loopDelayMs();
    if (delay !== null && delay >= LOOP_DELAY_MS) return `event loop delayed ${Math.round(delay / 100) / 10}s`;
    return null;
  };

  const reason = (): string | null => {
    if (!enabled()) return null;
    const at = now();
    if (last && at >= last.at && at - last.at < PRESSURE_READ_MS) return last.why;
    let found: string | null = null;
    try { found = why(); } catch {}
    last = { at, why: found };
    return found;
  };

  return {
    /** Why work that can wait should wait now, in a few words for the log; null when it need not. */
    reason,
    pressed: (): boolean => reason() !== null,
    /** A machine where two engine status checks at once are one too many. */
    small: (): boolean => {
      if (!enabled()) return false;
      const host = memory();
      return (host !== null && host.totalBytes <= SMALL_MEMORY_BYTES) || cpus() <= SMALL_CPUS;
    },
  };
}

export const machinePressure = createMachinePressure();
