// When a routine's checks may hand work to the AI. The checks themselves always run (reminders and the brief need no
// AI); these rules only hold back the one run their items would start, and held items wait for a later check.
import { outcomesNewestFirst } from "./routine-outcomes.ts";
import type { RoutineRun } from "./routines.ts";

/** The first checks after OpenMausBot starts wait this long, so they never compete with the person's first prompt. */
export const CHECK_BOOT_HOLD_MS = 2 * 60_000;
/** AI runs a routine's checks may start in any 24 hours: email triage and meeting prep together. */
export const CHECK_RUNS_PER_DAY = 24;
const DAY_MS = 24 * 60 * 60_000;
const BACKOFF_FIRST_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 4 * 60 * 60_000;

/** Why no AI run may start now: one is already queued or working, the day's runs are used up, or the last ones failed. */
export type CheckHold = "running" | "capped" | "backoff";

const ACTIVE = new Set(["queued", "running", "waiting"]);

export function checkRunsLeft(runs: readonly RoutineRun[], routineId: string, now: number): number {
  const used = runs.filter((run) => run.routineId === routineId && run.checkKey !== undefined && !run.manual && run.createdAt > now - DAY_MS).length;
  return Math.max(0, CHECK_RUNS_PER_DAY - used);
}

/** The same fraction for every retry of one streak, so a backoff never shortens between ticks. */
function jitter(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 0.8 + (hash % 1000) / 2500;
}

/** After `n` failed runs in a row, the next waits 15 minutes doubled n−1 times, at most 4 hours, give or take a fifth. */
export function checkBackoffUntil(runs: readonly RoutineRun[], routineId: string): number | null {
  const outcomes = outcomesNewestFirst(runs, routineId);
  const streak = outcomes.findIndex((run) => run.status !== "failed");
  const failed = streak < 0 ? outcomes.length : streak;
  if (failed === 0) return null;
  const last = outcomes[0]!;
  const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (failed - 1)) * jitter(last.id);
  return (last.finishedAt ?? last.createdAt) + wait;
}

export function checkHold(runs: readonly RoutineRun[], routineId: string, now: number, except?: string): CheckHold | undefined {
  if (runs.some((run) => run.routineId === routineId && run.id !== except && ACTIVE.has(run.status))) return "running";
  if (except !== undefined) return undefined;
  if (checkRunsLeft(runs, routineId, now) === 0) return "capped";
  const until = checkBackoffUntil(runs, routineId);
  return until !== null && until > now ? "backoff" : undefined;
}
