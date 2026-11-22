// A routine whose runs keep failing is never turned off for it. Each failed run spent the bot's AI, so after a few in a
// row its scheduled runs are spaced out as for a cloud computer that does not start, and every occurrence held back is
// counted on one `missed` row. The first run that completes, turning the routine on again, or any change to it ends the
// spacing, and so does a run only the owner's AI account stopped (signed out, out of credit, a usage limit) or that the
// lent computer refused because its routine isn't confirmed as theirs. A run that never started work counts for nothing here.
import { envWhole } from "./env-limits.ts";
import { afterSpacing, noStartSpacing } from "./routine-no-start.ts";
import { outcomesNewestFirst } from "./routine-outcomes.ts";
import type { RoutineAlert } from "./routine-recovery.ts";
import type { SkipWhy } from "./routine-skips.ts";

type Outcome = { id: string; routineId: string; status: string; error?: string | null; createdAt: number; startedAt?: number | null; finishedAt?: number | null; ownerCause?: string; lendingRefused?: true };
type Spaced = { id: string; updatedAt: number };

export interface FailureSpacingLimits {
  /** Failed runs in a row before the routine's next scheduled runs are spaced out. */
  runs: number;
  /** How long after the last failure the next scheduled run waits: at that failure, and from the one after it on. */
  firstMs: number;
  laterMs: number;
}

export const FAILED_RUNS_BEFORE_SPACING = 3;
export const FAILURE_FIRST_SPACING_MS = 60 * 60_000;
export const FAILURE_SPACING_MS = 4 * 60 * 60_000;

/** OMB_ROUTINE_FAILURES_BEFORE_SPACING (from 1), OMB_ROUTINE_FAILURE_SPACING_MS and OMB_ROUTINE_FAILURE_SPACING_MAX_MS
 * (whole milliseconds from 60000, the second never below the first); anything else leaves the default. */
export function failureSpacingLimits(env: NodeJS.ProcessEnv = process.env): FailureSpacingLimits {
  const firstMs = envWhole(env.OMB_ROUTINE_FAILURE_SPACING_MS, FAILURE_FIRST_SPACING_MS, 60_000);
  return { runs: envWhole(env.OMB_ROUTINE_FAILURES_BEFORE_SPACING, FAILED_RUNS_BEFORE_SPACING), firstMs,
    laterMs: Math.max(firstMs, envWhole(env.OMB_ROUTINE_FAILURE_SPACING_MAX_MS, FAILURE_SPACING_MS, 60_000)) };
}

/** The routine's newest failed runs that started work, since it last completed a run, was turned on or was changed, or
 * a run failed only on the owner's AI account (signed out, out of credit, a usage limit) or on a routine not confirmed
 * for the lent computer: that ends a streak and any spacing it began, since the cause changed. */
export function failedRuns<T extends Outcome>(routine: Spaced, runs: readonly T[]): T[] {
  const outcomes = outcomesNewestFirst(runs, routine.id);
  const end = outcomes.findIndex((run) => run.status !== "failed" || run.createdAt < routine.updatedAt || run.ownerCause !== undefined || run.lendingRefused === true);
  return (end < 0 ? outcomes : outcomes.slice(0, end)).filter((run) => run.startedAt != null);
}

/** Until when the routine's scheduled runs are held back for failing, and the failure the spacing counts from; null when they are not. */
export function failureSpacing<T extends Outcome>(routine: Spaced, runs: readonly T[], limits = failureSpacingLimits()): { until: number; last: T; streak: number } | null {
  const failed = failedRuns(routine, runs), last = failed[0];
  if (!last || failed.length < limits.runs) return null;
  return { until: (last.finishedAt ?? last.createdAt) + (failed.length === limits.runs ? limits.firstMs : limits.laterMs), last, streak: failed.length };
}

export interface RunSpacing<T> { until: number; last: T; streak: number; behind: string; why: SkipWhy }

/** The spacing that holds the routine's scheduled runs back longest: for a cloud computer that did not start, or for failed runs. */
export function runSpacing<T extends Outcome>(routine: Spaced, runs: readonly T[], limits = failureSpacingLimits()): RunSpacing<T> | null {
  const noStart = noStartSpacing(routine, runs), failed = failureSpacing(routine, runs, limits);
  if (noStart && (!failed || noStart.until >= failed.until)) return { ...noStart, behind: `no-start:${noStart.last.id}`, why: "routines.server.part.computerNoStart" };
  return failed && { ...failed, behind: `failed:${failed.last.id}`, why: "routines.server.part.runsFailed" };
}

/** What the owner is told, once, by the failure that begins the spacing; nothing for a routine that is off, whose schedule starts no run to space. */
export function failureSpacingAlert<T extends Outcome>(routine: Spaced & { enabled?: boolean } | undefined, runs: readonly T[], run: T, limits = failureSpacingLimits()): RoutineAlert | undefined {
  const failed = routine && routine.enabled !== false ? failedRuns(routine, runs) : [];
  if (failed.length !== limits.runs || failed[0]?.id !== run.id) return undefined;
  return { detail: `${run.error} ${limits.runs} runs in a row failed. It stays on, and tries again less often until a run completes.` };
}

/** The routine as wake and sleep planning should see it: its next run is the first occurrence a spacing does not skip. */
export function afterRunSpacing<R extends Spaced & { enabled: boolean; nextRunAt: number | null; schedule: unknown }, T extends Outcome>(routine: R, runs: readonly T[], now: number, next: (schedule: R["schedule"], after: number) => number | null): R {
  return afterSpacing(routine, runs, now, next, runSpacing);
}
