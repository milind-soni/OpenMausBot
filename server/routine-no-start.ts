// A routine whose cloud computer does not start is never turned off for it: each such run spends the bot's AI for minutes
// before it fails, so after a few in a row its scheduled runs are spaced out instead, and every occurrence held back is
// counted on one `missed` row (routine-skips.ts). The first run whose computer starts, turning the routine on again, or
// any change to it ends the spacing.
import { PLACE_EN } from "../shared/place-view.ts";
import { outcomesNewestFirst } from "./routine-outcomes.ts";
import type { RoutineAlert } from "./routine-recovery.ts";

type Outcome = { id: string; routineId: string; status: string; error?: string | null; createdAt: number; finishedAt?: number | null };
type Spaced = { id: string; updatedAt: number };

/** Runs in a row that failed this way before the routine's next scheduled runs are spaced out. */
export const NO_START_RUNS_BEFORE_SPACING = 3;
/** How long after the last such failure the next scheduled run waits: at the third in a row, and from the fourth on. */
export const NO_START_FIRST_SPACING_MS = 60 * 60_000;
export const NO_START_SPACING_MS = 4 * 60 * 60_000;

const [beforeBot, afterBot] = PLACE_EN["place.view.ccNoStart.line"].split("{bot}").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const NO_START = new RegExp(`^${beforeBot}.+${afterBot}`);

/** The run failed because its cloud computer did not start. A busy or unavailable Cloud service reads differently and is not this. */
export const failedToStartComputer = (run: Pick<Outcome, "status" | "error">): boolean => run.status === "failed" && Boolean(run.error) && NO_START.test(run.error!);

/** The routine's newest outcomes, since it was last turned on or changed, that all failed because its cloud computer did not start. */
export function noStartRuns<T extends Outcome>(routine: Spaced, runs: readonly T[]): T[] {
  const outcomes = outcomesNewestFirst(runs, routine.id);
  const end = outcomes.findIndex((run) => !failedToStartComputer(run) || run.createdAt < routine.updatedAt);
  return end < 0 ? outcomes : outcomes.slice(0, end);
}

/** Until when the routine's scheduled runs are held back, and the failure the spacing counts from; null when they are not. */
export function noStartSpacing<T extends Outcome>(routine: Spaced, runs: readonly T[]): { until: number; last: T; streak: number } | null {
  const failed = noStartRuns(routine, runs), last = failed[0];
  if (!last || failed.length < NO_START_RUNS_BEFORE_SPACING) return null;
  const wait = failed.length === NO_START_RUNS_BEFORE_SPACING ? NO_START_FIRST_SPACING_MS : NO_START_SPACING_MS;
  return { until: (last.finishedAt ?? last.createdAt) + wait, last, streak: failed.length };
}

/** What the owner is told, once, by the failure that begins the spacing. */
export function noStartAlert<T extends Outcome>(routine: Spaced | undefined, runs: readonly T[], run: T): RoutineAlert | undefined {
  if (!routine || !failedToStartComputer(run) || noStartRuns(routine, runs).length !== NO_START_RUNS_BEFORE_SPACING || noStartRuns(routine, runs)[0]?.id !== run.id) return undefined;
  return { detail: `${run.error} ${NO_START_RUNS_BEFORE_SPACING} runs in a row failed this way. It stays on, and tries again less often until its cloud desktop starts.` };
}

/** The routine as the computer's wake and sleep planning should see it: while its runs are spaced out, its next run is the
 * first occurrence at or after the spacing's end (`next` gives a schedule's first occurrence after a time), not one that
 * will only be skipped. */
export function afterSpacing<R extends Spaced & { enabled: boolean; nextRunAt: number | null; schedule: unknown }, T extends Outcome>(routine: R, runs: readonly T[], now: number, next: (schedule: R["schedule"], after: number) => number | null): R {
  const spaced = routine.enabled && routine.nextRunAt !== null ? noStartSpacing(routine, runs) : null;
  if (!spaced || spaced.until <= now || routine.nextRunAt! >= spaced.until) return routine;
  return { ...routine, nextRunAt: next(routine.schedule, spaced.until - 1) };
}

type Switched<Hold> = Spaced & { enabled: boolean; heldFor?: Hold; nextRunAt: number | null; schedule: { type: string } };
/** How far apart the failure's end and the routine's last change may be for the switch-off to be the failure's own: both
 * were stamped in one synchronous step. */
const SAME_STEP_MS = 1_000;
/** A switch-off older than this is left as the person has lived with it. */
export const SWITCHED_OFF_WITHIN_MS = 30 * 24 * 60 * 60_000;

/** Routines that an earlier version turned off after three such failures in a row, which left no marker: one is
 * recognised only when it is off without a hold, its three newest outcomes are that failure with one wording, the
 * newest of them ended within SWITCHED_OFF_WITHIN_MS, and its last change is the instant that one ended. One changed
 * since (a person's edit, a workspace restore), or whose failed runs are gone, is not among them. */
export function switchedOffByNoStarts<R extends Switched<unknown>, T extends Outcome>(routines: readonly R[], runs: readonly T[], now: number): R[] {
  return routines.filter((routine) => {
    if (routine.enabled || routine.heldFor !== undefined || routine.schedule.type === "once") return false;
    const newest = outcomesNewestFirst(runs, routine.id).slice(0, NO_START_RUNS_BEFORE_SPACING), last = newest[0];
    if (!last || newest.length < NO_START_RUNS_BEFORE_SPACING || newest.some((run) => !failedToStartComputer(run) || run.error !== last.error)) return false;
    const gap = routine.updatedAt - (last.finishedAt ?? NaN);
    return gap >= 0 && gap <= SAME_STEP_MS && now - last.finishedAt! <= SWITCHED_OFF_WITHIN_MS && !runs.some((run) => run.routineId === routine.id && run.createdAt > routine.updatedAt);
  });
}

/** Turns those routines back on from `now` (`next` is a schedule's first occurrence from then), or, while a cause holds
 * every routine (`hold`), stamps them with it so they come back when it ends. Each counts as changed, so its spacing starts afresh. */
export function turnBackOn<Hold, R extends Switched<Hold>, T extends Outcome>(routines: readonly R[], runs: readonly T[], hold: Hold | undefined, now: number, next: (schedule: R["schedule"], now: number) => number | null): R[] {
  const back = switchedOffByNoStarts(routines, runs, now);
  for (const routine of back) {
    const at = next(routine.schedule, now);
    Object.assign(routine, hold !== undefined ? { heldFor: hold } : at === null ? {} : { enabled: true, nextRunAt: at }, { updatedAt: Math.max(now, routine.updatedAt + 1) });
  }
  return back;
}
