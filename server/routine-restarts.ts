// What a server start does to routines when the server may be crashing and starting again in a loop. A start with no
// desktop launch (a headless server) runs its startup routines at most once in OMB_STARTUP_ROUTINE_GAP_MS, counted from
// the start that last ran them, and each start it skips adds to one row per routine. Runs a restart cut off start again
// one after another, OMB_ROUTINE_RESTART_STAGGER_MS apart, not all at the same moment.
import { envWhole } from "./env-limits.ts";
import { ROUTINE_RETRY_MS } from "./routine-recovery.ts";

export const STARTUP_ROUTINE_GAP_MS = 30 * 60_000;
export const ROUTINE_RESTART_STAGGER_MS = 30_000;

/** OMB_STARTUP_ROUTINE_GAP_MS, whole milliseconds from 0 (0 runs them at every start); anything else leaves the default. */
export const startupRoutineGapMs = (env: NodeJS.ProcessEnv = process.env): number => envWhole(env.OMB_STARTUP_ROUTINE_GAP_MS, STARTUP_ROUTINE_GAP_MS, 0);
/** OMB_ROUTINE_RESTART_STAGGER_MS, whole milliseconds from 0; anything else leaves the default. */
export const restartStaggerMs = (env: NodeJS.ProcessEnv = process.env): number => envWhole(env.OMB_ROUTINE_RESTART_STAGGER_MS, ROUTINE_RESTART_STAGGER_MS, 0);

const HEADLESS_START = /^at:(\d{1,16})$/;

export type StartupDecision = { run: true; marker: string | undefined } | { run: false; behind: (routineId: string) => string };

/** Whether this start runs its startup routines, and what it records: the desktop's launch, or for a headless server the
 * time it ran them (`last` is what the previous start recorded). A skip is counted on one row per routine and window. */
export function startupDecision(launchId: string | undefined, last: string | undefined, now: number, gapMs = startupRoutineGapMs()): StartupDecision {
  if (launchId !== undefined) return { run: true, marker: launchId };
  const ranAt = HEADLESS_START.exec(last ?? "")?.[1];
  if (ranAt !== undefined && now >= Number(ranAt) && now - Number(ranAt) < gapMs) return { run: false, behind: (routineId) => `startup:${ranAt}:${routineId}` };
  return { run: true, marker: `at:${now}` };
}

/** When the `index`-th run a restart cut off may start again: in turn, and not before `held` (another machine's lease). */
export function restartRetryAt(now: number, index: number, held: number | undefined, staggerMs = restartStaggerMs()): number {
  return Math.max(held ?? 0, now + ROUTINE_RETRY_MS + index * staggerMs);
}
