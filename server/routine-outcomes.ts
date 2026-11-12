import { PLACE_EN } from "../shared/place-view.ts";

type Outcome = { id: string; routineId: string; status: string; error?: string | null; createdAt: number; finishedAt?: number | null };

/** A routine's finished runs (failed or completed), newest first. */
export function outcomesNewestFirst<T extends Outcome>(runs: readonly T[], routineId: string, exceptRunId?: string): T[] {
  return runs.filter(run => run.routineId === routineId && run.id !== exceptRunId && (run.status === "failed" || run.status === "completed")).reverse()
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt) || b.createdAt - a.createdAt);
}

/** The run failed the same way the routine's previous outcome did. */
export function failsLikeLastOutcome<T extends Outcome>(runs: readonly T[], run: T): boolean {
  const last = outcomesNewestFirst(runs, run.routineId, run.id)[0];
  return last?.status === "failed" && last.error === run.error;
}

/** Runs in a row, since the routine was last turned on or changed, that failed because its cloud computer didn't start. */
export const NO_START_RUNS_BEFORE_OFF = 3;
const [beforeBot, afterBot] = PLACE_EN["place.view.ccNoStart.line"].split("{bot}").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const NO_START = new RegExp(`^${beforeBot}.+${afterBot}`);

/** Each run on a cloud computer that doesn't start spends the bot's AI for minutes before it fails, so the third such
 * run in a row turns the routine off and says so. Turning it on again, or any change, starts the count afresh. A busy
 * or unavailable Cloud service is not counted: that passes by itself, and nothing would turn the routine back on. */
export function offAfterNoStarts<R extends { enabled: boolean; nextRunAt: number | null; updatedAt: number }, T extends Outcome>(routine: R | undefined, runs: readonly T[], run: T, now: number): { routine: R; alert: { detail: string } } | undefined {
  if (!routine?.enabled || run.status !== "failed" || !run.error || run.createdAt < routine.updatedAt || !NO_START.test(run.error)) return undefined;
  const earlier = outcomesNewestFirst(runs, run.routineId, run.id).slice(0, NO_START_RUNS_BEFORE_OFF - 1);
  if (earlier.length < NO_START_RUNS_BEFORE_OFF - 1 || earlier.some((other) => other.status !== "failed" || other.error !== run.error || other.createdAt < routine.updatedAt)) return undefined;
  Object.assign(routine, { enabled: false, nextRunAt: null, updatedAt: Math.max(now, routine.updatedAt + 1) });
  return { routine, alert: { detail: `${run.error} It was turned off after ${NO_START_RUNS_BEFORE_OFF} runs in a row failed this way: turn it on again once its computer starts.` } };
}
