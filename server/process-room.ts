// A server in a container may hold only so many processes and threads (its cgroup's pids.max); past that every spawn
// fails with EAGAIN. The gate that holds turns for memory (engine-memory.ts) asks here whether one more engine fits.
import { containerLimited, readPids } from "./process-limits.ts";
import type { ShortageCode } from "./process-shortage.ts";

/** What one working bot holds against pids.max: its engine and the five tool servers a default bot's engine starts ran as
 * 6 processes with 44 threads (a scripted engine on Node 24, 2026-11-16); a real engine CLI and the commands it runs add
 * to that. */
export const ENGINE_TASKS = 60;
/** One more session in an engine process that is already running: its tool servers. */
export const SESSION_TASKS = 40;
/** One bot's browser: 13 processes with 163 threads (agent-browser 0.37.0 and Chromium 156 on one page, 2026-11-16). */
export const BROWSER_TASKS = 170;
/** The server, its launcher and init, and what the server runs for itself (git, probes). */
const SERVER_TASKS = 40;
/** After a refused spawn that names no pids limit (open files, memory), nothing new starts for this long. */
const SHORTAGE_HOLD_MS = 30_000;
/** A limit learned from a refused spawn is kept this long after the last refusal: the refusal may have been another
 * limit's (ulimit -u, shared with every process of the same user), or the container's may have been raised. */
const LEARNED_FOR_MS = 30 * 60_000;

/** Kept below the limit for what nobody counts ahead: a command's own children, a probe, a thread pool growing. */
export const margin = (limit: number) => Math.max(32, Math.round(limit * 0.1));
/** How many engines fit under a pids limit. */
export const turnsUnder = (limit: number) => Math.max(1, Math.floor((limit - margin(limit) - SERVER_TASKS) / ENGINE_TASKS));

export type SpawnFailureCode = ShortageCode | "ENOENT" | "other";
export interface ProcessCounts {
  /** The pids limit the gate works to: the cgroup's, or the count at which a spawn was first refused. Null: none known. */
  limit: number | null;
  spawnFailed: Record<SpawnFailureCode, number>;
  forceKilled: number;
  lateReaped: number;
}

export interface ProcessBudgetOptions {
  read?: () => { max: number | "max" | null; current: number | null };
  now?: () => number;
  log?: (line: string) => void;
}

export class ProcessBudget {
  private readonly read: () => { max: number | "max" | null; current: number | null };
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** The count at which the kernel first refused a spawn: the limit, where none can be read (one set on a parent cgroup). */
  private learned: { limit: number; at: number } | null = null;
  private holdUntil = -Infinity;
  private readonly spawnFailures: Record<SpawnFailureCode, number> = { EAGAIN: 0, EMFILE: 0, ENFILE: 0, ENOMEM: 0, ENOENT: 0, other: 0 };
  private forceKilled = 0;
  private lateReaped = 0;
  private refused: (() => void) | null = null;

  constructor(options: ProcessBudgetOptions = {}) {
    this.read = options.read ?? (() => readPids());
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.warn(`processes: ${line}`));
  }

  /** Called when the system refuses a spawn for want of room: whoever holds turns back looks again. */
  onRefused(refused: () => void): void { this.refused = refused; }

  /** Two small files, read each time: a count a moment old would hold a turn back after the room it waited for came. */
  private state(): { max: number | "max" | null; current: number | null } { return this.read(); }

  /** The limit in force; null where none is set, readable or learned. */
  limit(): number | null {
    const { max } = this.state();
    if (typeof max === "number") return max;
    if (this.learned && this.now() - this.learned.at >= LEARNED_FOR_MS) this.learned = null;
    return this.learned?.limit ?? null;
  }

  /** Whether `tasks` more, on top of `held` already promised to engines still starting, would not fit. */
  short(tasks: number, held: number): boolean {
    if (this.now() < this.holdUntil) return true;
    const limit = this.limit(), { current } = this.state();
    return limit !== null && current !== null && current + held + tasks > limit - margin(limit);
  }

  /** Every spawn the operating system refused, by its code. A pids refusal also teaches the limit where none is readable. */
  spawnFailed(code: string | undefined): void {
    const known: SpawnFailureCode = code !== undefined && Object.hasOwn(this.spawnFailures, code) ? (code as SpawnFailureCode) : "other";
    this.spawnFailures[known] += 1;
    if (known === "ENOENT" || known === "other") return;
    this.holdUntil = this.now() + SHORTAGE_HOLD_MS;
    if (known === "EAGAIN") {
      const { max, current } = this.state();
      if (current !== null && typeof max !== "number") {
        const first = this.learned === null;
        this.learned = { limit: Math.min(this.learned?.limit ?? Infinity, Math.max(64, current)), at: this.now() };
        if (first) this.log(`a spawn was refused (EAGAIN) with ${current} processes and threads running; new work now waits below that count`);
      }
    }
    this.refused?.();
  }

  noteForceKilled(): void { this.forceKilled += 1; }
  noteLateReaped(): void { this.lateReaped += 1; }

  counts(): ProcessCounts {
    return { limit: this.limit(), spawnFailed: { ...this.spawnFailures }, forceKilled: this.forceKilled, lateReaped: this.lateReaped };
  }
}

export const processBudget = new ProcessBudget();

export type TurnsSetting = number | "auto" | "off";

/** OMB_TURNS_MAX_RUNNING: a whole number of turns at once; "off" or 0 for no gate at all; "auto", unset or anything else
 * for a number worked out from the server's memory and pids limit. */
export function turnsSetting(value: string | undefined): TurnsSetting {
  const text = value?.trim().toLowerCase();
  if (text === "off" || text === "0") return "off";
  return text && /^\d+$/.test(text) ? Number(text) : "auto";
}

export type GateHost = "cloud" | "server" | null;

/** Where turns wait for room. A Cloud home, as before. A self-hosted Linux server in a container that was given a memory
 * or pids limit, which is where a turn too many ends in a killed engine or a refused spawn. Any self-hosted server whose
 * operator set OMB_TURNS_MAX_RUNNING to a number or "auto". Never the desktop app's own server. */
export function gateHost(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, limited: () => boolean = containerLimited): GateHost {
  if ((env.OMB_CLOUD_ROLE === "home" || env.OMB_CLOUD_ROLE === "team") && platform === "linux") return "cloud";
  if (env.OMB_DESKTOP_PARENT === "1") return null;
  const setting = turnsSetting(env.OMB_TURNS_MAX_RUNNING);
  if (setting === "off") return null;
  if (typeof setting === "number" || env.OMB_TURNS_MAX_RUNNING?.trim().toLowerCase() === "auto") return "server";
  return platform === "linux" && limited() ? "server" : null;
}
