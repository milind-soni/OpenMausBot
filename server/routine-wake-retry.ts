// A scheduled run whose cloud computer did not wake never began: its turn did not start, so nothing of it can be
// repeated by starting it again. A provider that stops answering for a few minutes would otherwise cost that whole
// occurrence, so the same run row stays queued and asks for its computer again, a few times, a little later each time
// (the run gate in cloud-computer-run-gate.ts wakes it afresh). The tries end as soon as one starts, after the last
// of WAKE_RETRY_AFTER_MS, or once another try could still be under way when the routine's next occurrence is due: that
// occurrence takes over. A try is never queued outside the hours or days an interval schedule allows. A routine whose
// schedule has no next occurrence (a once-only one, an interval past its end) keeps its tries, up to the same count.
// The row is saved queued with its `retryAt` and `wakeRetryUntil` like any other queued run, so a restart in between
// keeps it, and a try still waiting at `wakeRetryUntil` (the server or the computer it runs on was asleep) is given up.
// Only the plain "did not wake" reason is tried again: a computer that woke and did not answer was already waited for
// and restarted, and the provider refusing the wake (a plan or start limit) answers the same way later.
import { RUN_COMPUTER_LINES } from "../shared/cloud-computer-recovery.ts";
import { runsOnce } from "../shared/limit-reset.ts";
import { intervalAllowsOccurrence, isSameLocalDay } from "./routine-intervals.ts";
import { codedLine } from "./routine-lines.ts";
import { whenParams } from "./routine-recovery.ts";
import { nextOccurrence } from "./routine-schedules.ts";
import type { Routine, RoutineRun } from "./routines.ts";

export interface WakeRetryMark {
  /** How many times this run was queued again because its cloud computer did not wake. */
  wakeRetries?: number;
  /** A try still waiting at this time is given up: the routine's next occurrence, or for a schedule with none, the latest
   * a missed occurrence is still started. */
  wakeRetryUntil?: number;
}

/** When each try again comes, counted from the run's scheduled time: a try itself takes up to about four minutes
 * (finding the computer, then the wake's own budget), so these leave a few minutes between tries. */
export const WAKE_RETRY_AFTER_MS = [5, 12, 20].map((minutes) => minutes * 60_000);
/** The least time between a try that did not wake and the next, for a run that started late. */
export const WAKE_RETRY_GAP_MS = 2 * 60_000;
/** The longest one try can still be waking its computer: a try is queued only if it ends before the next occurrence. */
export const WAKE_TRY_MS = 5 * 60_000;
/** For a schedule with no next occurrence: as late as the scheduler still starts a missed occurrence (CATCH_UP_MS in
 * routine-catch-up.ts, which imports this module through routine-execution.ts, so the value is repeated here). */
export const WAKE_RETRY_LAST_MS = 12 * 60 * 60_000;

type Run = Pick<RoutineRun, "status" | "target" | "scheduledFor" | "retryAt" | "attention" | "error" | "startedAt" | "retried"> & WakeRetryMark
  & Partial<Pick<RoutineRun, "attentionCode" | "attentionParams" | "errorCode" | "errorParams">>;
type Scheduled = Pick<Routine, "enabled" | "nextRunAt" | "schedule">;

/** The schedule itself has no occurrence after this run's: a once-only routine, or an interval past its end. A routine a
 * person turned off is not this. */
const lastOccurrence = (routine: Scheduled, run: Pick<RoutineRun, "scheduledFor">): boolean =>
  runsOnce(routine.schedule) || (routine.schedule.type === "interval" && nextOccurrence(routine.schedule, run.scheduledFor) === null);

/** An interval schedule with hours or weekdays starts a queued run only inside them, on its occurrence's day. */
function allowedAt(routine: Scheduled, run: Pick<RoutineRun, "scheduledFor">, at: number): boolean {
  const schedule = routine.schedule;
  if (schedule.type !== "interval") return true;
  const sameDay = schedule.weekdays === undefined && schedule.window === undefined ? true : isSameLocalDay(run.scheduledFor, at);
  return sameDay && intervalAllowsOccurrence(schedule, at);
}

/** The run's tries are over: the line it fails with, its codes put on the run. */
export function wakeGiveUp(run: Run, routine: Pick<Routine, "nextRunAt"> | undefined): string {
  const line = codedLine("error", routine?.nextRunAt == null ? "routines.server.noWakeRetriedLast" : "routines.server.noWakeRetried");
  Object.assign(run, line.codes, { attentionCode: undefined, attentionParams: undefined });
  return line.text;
}

/** What a run whose start was refused for `reason` becomes. `routine` is its schedule's routine, only for a run its
 * schedule started. true: queued again, with its `retryAt` and line. A string: the line to fail it with, its codes
 * already on the run. */
export function wakeRetry(run: Run, reason: string, routine: Scheduled | undefined, now: number): true | string {
  if (reason !== RUN_COMPUTER_LINES.noWake || run.target !== "bot" || !routine || run.startedAt != null || run.retried !== undefined) return reason;
  const tries = run.wakeRetries ?? 0;
  const at = tries < WAKE_RETRY_AFTER_MS.length ? Math.max(run.scheduledFor + WAKE_RETRY_AFTER_MS[tries]!, now + WAKE_RETRY_GAP_MS) : null;
  const next = routine.nextRunAt, last = next === null && lastOccurrence(routine, run);
  const until = next !== null && routine.enabled ? next : last ? run.scheduledFor + WAKE_RETRY_LAST_MS : null;
  if (at !== null && until !== null && at + WAKE_TRY_MS <= until && allowedAt(routine, run, at)) {
    const line = codedLine("attention", "routines.server.wakeRetry", whenParams(at));
    Object.assign(run, line.codes, { status: "queued", retryAt: at, wakeRetries: tries + 1, wakeRetryUntil: until, attention: line.text });
    delete run.error;
    return true;
  }
  return tries === 0 ? reason : wakeGiveUp(run, routine);
}

/** A run queued again by wakeRetry and not started since. A run that started and was queued again for another reason (a
 * restart, a failure's one retry) keeps its own rules. */
export const waitsToWakeAgain = (run: Pick<RoutineRun, "status" | "startedAt" | "retried"> & WakeRetryMark): boolean =>
  run.status === "queued" && (run.wakeRetries ?? 0) > 0 && run.startedAt == null && run.retried === undefined;

/** At each scheduler pass, before any routine comes due: a try still waiting at its `wakeRetryUntil` is given up, with
 * the line to fail it with; null otherwise. */
export function wakeRetryEnded(run: Run, now: number, routine: Pick<Routine, "nextRunAt"> | undefined): string | null {
  return waitsToWakeAgain(run) && run.wakeRetryUntil !== undefined && now >= run.wakeRetryUntil ? wakeGiveUp(run, routine) : null;
}

/** `wakeRetries` as routines.json may hold it: a small whole count, or nothing. */
export const loadWakeRetries = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= WAKE_RETRY_AFTER_MS.length ? value as number : undefined;
