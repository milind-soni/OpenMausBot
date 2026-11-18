// A scheduled run whose cloud computer did not wake never began: its turn did not start, so nothing of it can be
// repeated by starting it again. A provider that stops answering for a few minutes would otherwise cost that whole
// occurrence, so the same run row stays queued and asks for its computer again, a few times, a little later each time
// (the run gate in cloud-computer-run-gate.ts wakes it afresh). The tries end as soon as one starts, after the last
// of WAKE_RETRY_AFTER_MS, or once another try could still be under way when the routine's next occurrence is due: that
// occurrence takes over. The row is saved queued with its `retryAt` like any other queued run, so a restart in between
// keeps it. Only the plain "did not wake" reason is tried again: a computer that woke and did not answer was already
// waited for and restarted, and the provider refusing the wake (a plan or start limit) answers the same way later.
import { RUN_COMPUTER_LINES } from "../shared/cloud-computer-recovery.ts";
import { codedLine } from "./routine-lines.ts";
import { whenParams } from "./routine-recovery.ts";
import type { Routine, RoutineRun } from "./routines.ts";

export interface WakeRetryMark {
  /** How many times this run was queued again because its cloud computer did not wake. */
  wakeRetries?: number;
}

/** When each try again comes, counted from the run's scheduled time: a try itself takes up to about four minutes
 * (finding the computer, then the wake's own budget), so these leave a few minutes between tries. */
export const WAKE_RETRY_AFTER_MS = [5, 12, 20].map((minutes) => minutes * 60_000);
/** The least time between a try that did not wake and the next, for a run that started late. */
export const WAKE_RETRY_GAP_MS = 2 * 60_000;
/** The longest one try can still be waking its computer: a try is queued only if it ends before the next occurrence. */
export const WAKE_TRY_MS = 5 * 60_000;

type Run = Pick<RoutineRun, "status" | "target" | "scheduledFor" | "retryAt" | "attention" | "error"> & WakeRetryMark & Partial<Pick<RoutineRun, "attentionCode" | "attentionParams" | "errorCode" | "errorParams">>;

/** What a run whose start was refused for `reason` becomes. `routine` is its schedule's routine, only for a run its
 * schedule started. true: queued again, with its `retryAt` and line. A string: the line to fail it with, its codes
 * already on the run. */
export function wakeRetry(run: Run, reason: string, routine: Pick<Routine, "enabled" | "nextRunAt"> | undefined, now: number): true | string {
  if (reason !== RUN_COMPUTER_LINES.noWake || run.target !== "bot" || !routine) return reason;
  const tries = run.wakeRetries ?? 0;
  const at = tries < WAKE_RETRY_AFTER_MS.length ? Math.max(run.scheduledFor + WAKE_RETRY_AFTER_MS[tries]!, now + WAKE_RETRY_GAP_MS) : null;
  const next = routine.nextRunAt;
  if (at !== null && routine.enabled && (next === null || at + WAKE_TRY_MS <= next)) {
    const line = codedLine("attention", "routines.server.wakeRetry", whenParams(at));
    Object.assign(run, line.codes, { status: "queued", retryAt: at, wakeRetries: tries + 1, attention: line.text });
    delete run.error;
    return true;
  }
  if (tries === 0) return reason;
  const line = codedLine("error", next === null ? "routines.server.noWakeRetriedLast" : "routines.server.noWakeRetried", { tries: tries + 1 });
  Object.assign(run, line.codes, { attentionCode: undefined, attentionParams: undefined });
  return line.text;
}

/** A run queued again by wakeRetry and not started since, which gives way when its routine's next occurrence comes due. A
 * run that started and was queued again for another reason (a restart, a failure's one retry) keeps its own rules. */
export const waitsToWakeAgain = (run: Pick<RoutineRun, "status" | "startedAt" | "retried"> & WakeRetryMark): boolean =>
  run.status === "queued" && (run.wakeRetries ?? 0) > 0 && run.startedAt == null && run.retried === undefined;

/** `wakeRetries` as routines.json may hold it: a small whole count, or nothing. */
export const loadWakeRetries = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= WAKE_RETRY_AFTER_MS.length ? value as number : undefined;
