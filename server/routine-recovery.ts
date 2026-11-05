// What an unattended routine run's failure turns into: a failure starts the run once more after a short wait, unless a
// second start could only repeat or undo it (a stall the turn watchdog stopped, a stop someone pressed or typed, a
// refusal, a spent cap); a busy target is waited for, a usage limit with a known reset is waited out, and what only the
// owner can fix fails at once and is told to them once per bot and cause, until one of that bot's runs completes.
// A teammate's failed thread takes the same verdict (host/chief-notices.ts).
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { ServerText } from "../shared/server-text.ts";
import type { RoutineRetryCause } from "../shared/routines.ts";
import { engineFailureKind } from "./drivers/engine-errors.ts";
import { classifyError } from "./drivers/retry.ts";
import { nextOccurrence } from "./routine-schedules.ts";
import type { Routine, RoutineRun } from "./routines.ts";
import { codedLine, fittedLine, type RoutineLine, type RoutineLineKey } from "./routine-lines.ts";
import { hostTimeZone } from "./turn-clock.ts";
import { classifyContinuable } from "./turn-continuation.ts";

export type RoutineOwnerCause = "signed_out" | "credits" | "usage_limit" | "setup";

/** What is known about a failure besides its words: a cause the server words itself, and the engine's own flags. */
export interface RoutineFailureFacts {
  /** stalled: the turn watchdog stopped it; cap: a spend or turn cap (or the repeat guard) ended it; refused: the server
   * would not start it, or its start failed before the turn began (judged by its words, never retried as a crash). */
  cause?: "stalled" | "busy" | "cap" | "refused";
  stopReason?: string | null;
  setup?: boolean;
  stalled?: boolean;
  trialCredit?: string;
  limitResetsAt?: number;
  /** A usage limit refused it (the runtime error's `limit`). */
  limit?: "engine" | "model" | "credits";
  /** A backup engine takes over from one whose usage limit refused the run, or that is signed out. */
  backupReady?: boolean;
  /** The next run a recurring routine's schedule starts, for a run that schedule started, and one interval of that schedule. */
  nextScheduled?: { at: number; interval: number };
  text?: ServerText;
  /** The turn's reply came back; only a step it ran failed or wasn't allowed (the runtime error's `partial`). */
  partial?: boolean;
}

export type RoutineFailureClass =
  | { kind: "retry"; cause: Exclude<RoutineRetryCause, "usage_limit"> }
  | { kind: "busy" }
  | { kind: "owner"; cause: RoutineOwnerCause; resetsAt?: number }
  | { kind: "final" };

/** A failure notification's own words; null stays quiet because the owner was already told. */
export interface RoutineAlert { detail: string }

export interface RoutineOwnerNotice { botId: string; cause: RoutineOwnerCause; at: number }

export type RoutineRecovery = { queued: true; alert?: RoutineAlert } | { queued: false; error: string; alert?: RoutineAlert | null };

const RETRY_MS = 15_000;
const RATE_LIMIT_RETRY_MS = 60_000;
export const ROUTINE_BUSY_RECHECK_MS = 30_000;
export const ROUTINE_BUSY_WAIT_MS = 60 * 60_000;
/** Past this, a usage limit fails the run instead: the routine's next scheduled runs come sooner. */
const LIMIT_WAIT_MS = 12 * 60 * 60_000;
const AFTER_RESET_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000, WEEK_MS = 7 * DAY_MS;
/** startTurn's codes for a bot or thread that is busy for now. */
const BUSY_CODES = new Set(["thread_busy", "thread_limit", "workspace_busy", "settling"]);
/** Stop reasons of a turn someone ended on purpose (Stop, a typed "stop", a settings change that cut it short), the AI
 * declined, or a tool call the person denied or that failed after its corrective rounds: a second start would undo or
 * repeat it. */
const NOT_RETRIED_STOPS = new Set(["cancelled", "interrupted", "refusal", "tool_error"]);
/** What the provider answered for a reason a second start would meet again. */
const REFUSED_KINDS = new Set(["refused", "tool_schema", "tool_count"]);
const OWNER_CAUSES = new Set<RoutineOwnerCause>(["signed_out", "credits", "usage_limit", "setup"]);

const OWNER_ACTION: Record<Exclude<RoutineOwnerCause, "setup">, string> = {
  signed_out: "This bot's AI is signed out. Sign in again in Settings → AI.",
  credits: "This bot's AI account is out of credit. Add credit with the provider, or choose another AI for this bot.",
  usage_limit: "This bot's AI reached its usage limit. Its routines work again once it resets, or choose another AI for this bot now.",
};
const TRIAL_ACTION = "The trial Claude credit can't run this. Sign in with your own Claude or ChatGPT account, or add an API key.";
const RETRY_WHY: Record<Exclude<RoutineRetryCause, "usage_limit" | "restarted">, RoutineLineKey> = {
  stalled: "routines.server.part.stalled", rate_limited: "routines.server.part.rateLimited", provider: "routines.server.part.provider",
  failed: "routines.server.part.failed",
};
const FIRST_START: Record<RoutineRetryCause, string> = {
  stalled: "stopped when its AI stalled", restarted: "was cut off when OpenMausBot restarted", rate_limited: "was stopped by a rate limit",
  provider: "failed on a temporary AI error", usage_limit: "was refused by the AI's usage limit", failed: "failed",
};

/** Any failure gets one automatic retry, except a stall the turn watchdog stopped (its Chief hears instead), a
 * stop someone pressed or typed, a refusal, and a spent cap. Routine runs and teammate threads both judge by this. */
export function classifyRoutineFailure(failure: string, facts: RoutineFailureFacts = {}): RoutineFailureClass {
  if (facts.cause === "busy") return { kind: "busy" };
  if (facts.cause === "stalled" || facts.cause === "cap") return { kind: "final" };
  if (facts.stopReason && NOT_RETRIED_STOPS.has(facts.stopReason)) return { kind: "final" };
  if (classifyContinuable(facts.stopReason, failure) === "cap") return { kind: "final" };
  if (facts.stalled) return { kind: "retry", cause: "stalled" };
  const engine = engineFailureKind(failure);
  const { reason, transient } = classifyError({ text: failure });
  if (facts.trialCredit || (engine === "credits" && !facts.limit)) return { kind: "owner", cause: "credits" };
  if (facts.limit || facts.limitResetsAt || facts.stopReason === "quota" || engine === "usage_limit") {
    return { kind: "owner", cause: "usage_limit", ...(facts.limitResetsAt ? { resetsAt: facts.limitResetsAt } : {}) };
  }
  if (facts.stopReason === "auth_required" || reason === "auth") return { kind: "owner", cause: "signed_out" };
  if (reason === "quota") return { kind: "owner", cause: "credits" };
  if (facts.setup || facts.stopReason === "update_required" || facts.stopReason === "setup_required") return { kind: "owner", cause: "setup" };
  if (engine === "rate_limit" || reason === "rate_limited") return { kind: "retry", cause: "rate_limited" };
  if (engine === "overloaded" || engine === "server" || transient) return { kind: "retry", cause: "provider" };
  // A failure nothing above names (a crash, an exit before the result): one more start. A refused start or a named refusal never.
  return reason === "unknown" && facts.cause !== "refused" && !(engine && REFUSED_KINDS.has(engine)) ? { kind: "retry", cause: "failed" } : { kind: "final" };
}

/** Why startTurn would not start a run: busy for now, the workspace spend cap, or any other refusal. A start that threw
 * without a status or code (an engine that would not spawn) is a failure like any other. */
export function dispatchRefusal(error: unknown): RoutineFailureFacts {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  if (typeof code === "string" && BUSY_CODES.has(code)) return { cause: "busy" };
  if (code === "spend_cap") return { cause: "cap" };
  return typeof code === "string" || (typeof status === "number" && status >= 400 && status < 500) ? { cause: "refused" } : {};
}

/** Whether OpenMausBot runs a failed teammate thread once more by itself before its Chief hears of it. */
export function retriesTeammateThread(failure: string, facts: RoutineFailureFacts = {}): boolean {
  return classifyRoutineFailure(failure, facts).kind === "retry";
}

export function engineFacts({ setup, stalled, trialCredit, limitResetsAt, limit, partial, text }: RuntimeEvent & { type: "runtime.error" }): RoutineFailureFacts {
  return { setup, stalled, trialCredit, limitResetsAt, limit, partial, text };
}

/** Host-local, with its zone: on a Cloud home the host's zone need not be the reader's. */
function when(at: number): string {
  return whenParams(at).resets;
}

function whenParams(at: number): { resets: string; resetsAt?: number; timeZone?: string } {
  const timeZone = hostTimeZone();
  try {
    return { resets: `${new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })} (${timeZone})`, resetsAt: at, timeZone };
  } catch {
    return { resets: `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` };
  }
}

function attend(run: RoutineRun, line: RoutineLine): void {
  Object.assign(run, line.codes, { attention: line.text });
}

/** Queues the run's one second start; false when it already had it or is not a bot's run. */
export function requeueOnce(run: RoutineRun, cause: RoutineRetryCause, failure: string, now: number,
  at = now + (cause === "rate_limited" ? RATE_LIMIT_RETRY_MS : RETRY_MS)): boolean {
  if (run.target !== "bot" || run.retried !== undefined) return false;
  run.status = "queued";
  run.retried = cause;
  run.retryAt = at;
  attend(run, cause === "usage_limit" ? codedLine("attention", "routines.server.limitWait", whenParams(at))
    : cause === "restarted" ? codedLine("attention", "routines.server.retryAfterRestart")
      : codedLine("attention", "routines.server.retryAfter", { why: RETRY_WHY[cause], failure }));
  delete run.error;
  return true;
}

/** The second start's own line, so a run that already did part of its work does not do it twice. */
export function retryNote(cause: RoutineRetryCause): string {
  return `[OpenMausBot: this run's first start ${FIRST_START[cause]} before it finished. If it already did part of the work, ` +
    "check what it did (files, messages sent, anything started) so nothing is done twice; then finish the routine.]";
}

function firstNotice(notices: RoutineOwnerNotice[], botId: string, cause: RoutineOwnerCause, at: number): boolean {
  if (notices.some((notice) => notice.botId === botId && notice.cause === cause)) return false;
  notices.push({ botId, cause, at });
  return true;
}

/** What a failed attempt becomes. A queued run is changed in place; a failing one is the caller's to fail with `error`. */
export function recoverRun(run: RoutineRun, failure: string, facts: RoutineFailureFacts, now: number, notices: RoutineOwnerNotice[]): RoutineRecovery {
  const verdict: RoutineFailureClass = run.target === "bot" ? classifyRoutineFailure(failure, facts) : { kind: "final" };
  const again = run.retried ? codedLine("error", "routines.server.failedAfterRetry", { failure }) : fittedLine("error", failure, facts.text);
  const failed = (line: RoutineLine, alert?: RoutineAlert | null): RoutineRecovery => {
    Object.assign(run, line.codes);
    return { queued: false, error: line.text, ...(alert === undefined ? {} : { alert }) };
  };
  if (verdict.kind === "busy") {
    run.deferredAt ??= now;
    // A run of checked items waits as long as it takes: its bot is busy with the person, which is not a failure.
    if (now - run.deferredAt >= ROUTINE_BUSY_WAIT_MS && run.checkKey === undefined) return failed(codedLine("error", "routines.server.stillBusy", { minutes: ROUTINE_BUSY_WAIT_MS / 60_000, failure }));
    run.status = "queued";
    run.retryAt = now + ROUTINE_BUSY_RECHECK_MS;
    attend(run, codedLine("attention", "routines.server.waitingToStart", { failure }));
    delete run.error;
    return { queued: true };
  }
  if (verdict.kind === "retry") return requeueOnce(run, verdict.cause, failure, now) ? { queued: true } : failed(again);
  if (verdict.kind === "final") return failed(again);
  if (verdict.cause === "usage_limit" && facts.backupReady && requeueOnce(run, "usage_limit", failure, now, now + RETRY_MS)) {
    attend(run, codedLine("attention", "routines.server.backupAi"));
    return { queued: true };
  }
  // A signed-out AI's run starts again on the backup the person chose; its start there says once that it needs signing in.
  if (verdict.cause === "signed_out" && facts.backupReady && requeueOnce(run, "failed", failure, now, now + RETRY_MS)) {
    attend(run, codedLine("attention", "routines.server.backupSignedOut"));
    return { queued: true };
  }
  const first = firstNotice(notices, run.botId, verdict.cause, now);
  const reset = verdict.resetsAt;
  // A recurring routine's next scheduled run, due within one interval after the reset, does the same work: no start at the reset.
  const nextCovers = reset !== undefined && facts.nextScheduled !== undefined && facts.nextScheduled.at <= reset + facts.nextScheduled.interval;
  if (reset && !nextCovers && reset > now && reset - now <= LIMIT_WAIT_MS && requeueOnce(run, "usage_limit", failure, now, reset + AFTER_RESET_MS)) {
    return { queued: true, ...(first ? { alert: { detail: `This bot's AI reached its usage limit. This run starts again at ${when(reset + AFTER_RESET_MS)}.` } } : {}) };
  }
  const action = verdict.cause === "setup" ? failure : verdict.cause === "credits" && facts.trialCredit ? TRIAL_ACTION : OWNER_ACTION[verdict.cause];
  return failed(verdict.cause === "signed_out" ? codedLine("error", "routines.server.signedOut", { failure }) : fittedLine("error", failure, verdict.cause === "setup" ? undefined : facts.text),
    first ? { detail: action } : null);
}

export function loadOwnerNotices(value: unknown): RoutineOwnerNotice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((notice) => typeof notice?.botId === "string" && OWNER_CAUSES.has(notice.cause) && Number.isFinite(notice.at)
    ? [{ botId: notice.botId, cause: notice.cause as RoutineOwnerCause, at: notice.at as number }] : []).slice(-500);
}

export function weekRuns(runs: readonly RoutineRun[], routineId: string, now: number): { ok: number; total: number } | undefined {
  let ok = 0, total = 0;
  for (const run of runs) {
    if (run.routineId !== routineId || !["completed", "failed", "missed"].includes(run.status) || (run.finishedAt ?? run.createdAt) < now - WEEK_MS) continue;
    total += 1;
    if (run.status === "completed") ok += 1;
  }
  return total ? { ok, total } : undefined;
}

/** A scheduled run's next scheduled occurrence and one interval of its schedule; none for a run started by hand, at startup or
 * by an event, or for a one-time or limit-reset routine. */
export function nextScheduledRun(run: RoutineRun, routines: readonly Routine[]): RoutineFailureFacts["nextScheduled"] {
  if ((run.triggerSource ?? (run.manual ? "manual" : "schedule")) !== "schedule") return undefined;
  const routine = routines.find((candidate) => candidate.id === run.routineId);
  if (!routine?.enabled || routine.nextRunAt == null) return undefined;
  const { schedule, nextRunAt: at } = routine;
  const following = schedule.type === "cron" ? nextOccurrence(schedule, at) : null;
  const interval = schedule.type === "interval" ? schedule.everyMinutes * 60_000 : schedule.type === "daily" ? DAY_MS
    : following !== null ? following - at : null;
  return interval === null ? undefined : { at, interval };
}
