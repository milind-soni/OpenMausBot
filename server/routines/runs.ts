// Run and schedule helpers with explicit dependencies: target readiness,
// first-occurrence math, run construction, results-thread cleanup, and the
// continuity carry. Bodies moved verbatim from manager.ts; persistent state
// stays owned by RoutineManager.
import { randomUUID } from "node:crypto";

import { redactSecretsInText } from "../redact.ts";
import type { RoutineManagerOptions } from "../routines.ts";
import { finishedOrder } from "./prompt.ts";
import type { RoutineContinuityCarry } from "./prompt.ts";
import { cloneAttachments } from "./persistence.ts";
import { nextOccurrence } from "./schedule.ts";
import type {
  Routine,
  RoutineInput,
  RoutineRun,
  RoutineSchedule,
  RoutineTarget,
  RoutineRunOn,
} from "./types.ts";

export type ResultsThreadAllocation = { botId: string; threadId: string };

/** Continuity reuses the bounded stored report, not the full transcript. */
const CONTINUITY_CHARS = 2_000;

export function targetState(
  target: Pick<RoutineRun, "target" | "groupId" | "botId">,
  options: Pick<RoutineManagerOptions, "botState" | "goalState">,
): "ready" | "busy" | "missing" {
  if (target.target === "room-goal") {
    if (!target.groupId || !options.goalState) return "missing";
    return options.goalState(target.groupId, target.botId);
  }
  return options.botState(target.botId);
}

export function missingTargetMessage(target: RoutineTarget): string {
  return target === "room-goal"
    ? "The assigned room or coordinator no longer exists"
    : "The assigned bot no longer exists";
}

export function initialOccurrence(schedule: RoutineSchedule, now: number): number | null {
  // Return the original time, not max(at, now): tick() already decides
  // whether a stale "once" run fires or is recorded as "missed" based on
  // how far past the scheduled time it is. Clamping to now here hides the
  // original schedule from the run receipt (scheduledFor would read "now"
  // instead of the time the user chose) and prevents the 12-hour missed
  // threshold from ever triggering for a "once" routine created late.
  if (schedule.type === "once") return schedule.at;
  return nextOccurrence(schedule, now);
}

/** The most recent completed report for a continuity routine, or `null` when
 * continuity is off, the routine is gone, or nothing has finished yet. The
 * text is redacted on the way in: a report can quote anything the run saw,
 * and continuity would otherwise carry it forward on every future run. */
export function continuityCarry(
  run: RoutineRun,
  routines: readonly Routine[],
  runs: readonly RoutineRun[],
): RoutineContinuityCarry | null {
  const routine = routines.find((candidate) => candidate.id === run.routineId);
  if (!routine?.continuity) return null;
  let latest: RoutineRun | null = null;
  for (const candidate of runs) {
    if (candidate.routineId !== run.routineId) continue;
    // Reassigning a routine must not disclose the old bot's report to a
    // different bot or execution destination.
    if (candidate.botId !== run.botId || candidate.target !== run.target || candidate.runOn !== run.runOn) continue;
    if (candidate.id === run.id) continue;
    if (candidate.status !== "completed") continue;
    if (!candidate.output?.trim()) continue;
    if (!Number.isFinite(finishedOrder(candidate))) continue;
    if (!latest || finishedOrder(candidate) > finishedOrder(latest)) latest = candidate;
  }
  if (!latest) return null;
  const redacted = redactSecretsInText(latest.output ?? "").trim();
  if (!redacted) return null;
  const truncated = redacted.length > CONTINUITY_CHARS;
  return {
    finishedAt: latest.finishedAt ?? latest.createdAt,
    output: truncated ? `${redacted.slice(0, CONTINUITY_CHARS - 1).trimEnd()}…` : redacted,
    truncated,
  };
}

export interface NewRunDeps {
  now: () => number;
  resolveResultsThread?: RoutineManagerOptions["resolveResultsThread"];
}

export interface WebhookRunInput {
  webhookId: string;
  webhookName: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  deliveryId: string;
  receivedAt: number;
}

/** Construct the queued run record for an accepted webhook delivery. */
export function webhookRun(input: WebhookRunInput, now: number): RoutineRun {
  return {
    id: randomUUID(),
    routineId: input.webhookId,
    routineName: input.webhookName,
    prompt: input.prompt,
    target: "bot",
    botId: input.botId,
    runOn: input.runOn,
    scheduledFor: input.receivedAt,
    status: "queued",
    manual: false,
    triggerSource: "webhook",
    webhookId: input.webhookId,
    deliveryId: input.deliveryId,
    attachments: [],
    createdAt: now,
  };
}

export function applyResultsInput(
  routine: Routine,
  value: RoutineInput["resultsThreadId"],
  options: RoutineManagerOptions,
) {
  if (routine.target !== "bot") {
    if (value != null) throw Object.assign(new Error("Results threads are only available for bot routines"), { status: 400 });
    delete routine.resultsThreadId;
    return;
  }
  if (value === undefined) return;
  if (value === null) {
    const destination = options.resolveResultsThread?.(routine, true);
    if (!destination) throw new Error("Could not create a results thread for this routine");
    routine.resultsThreadId = destination;
    return () => options.discardResultsThread?.(routine.botId, destination);
  }
  if (typeof value !== "string" || !value.trim() || !options.isResultsThread?.(routine.botId, value.trim())) {
    throw Object.assign(new Error("Choose a visible results thread belonging to this bot"), { status: 400 });
  }
  routine.resultsThreadId = value.trim();
}

export function newRun(
  routine: Routine,
  scheduledFor: number,
  manual: boolean,
  allocations: ResultsThreadAllocation[],
  deps: NewRunDeps,
  sourceThreadId = routine.sourceThreadId,
): RoutineRun {
  if (routine.target === "bot" && deps.resolveResultsThread) {
    const destination = deps.resolveResultsThread({ ...routine, sourceThreadId }, false);
    if (destination !== routine.resultsThreadId) {
      if (destination) allocations.push({ botId: routine.botId, threadId: destination });
      routine.resultsThreadId = destination;
      routine.updatedAt = Math.max(deps.now(), routine.updatedAt + 1);
    }
  }
  const run: RoutineRun = {
    id: randomUUID(),
    routineId: routine.id,
    routineName: routine.name,
    prompt: routine.prompt,
    durationMinutes: routine.durationMinutes,
    ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
    attachments: cloneAttachments(routine.attachments),
    target: routine.target,
    groupId: routine.groupId,
    botId: routine.botId,
    runOn: routine.runOn ?? "maus",
    scheduledFor,
    status: "queued",
    manual,
    triggerSource: manual ? "manual" : "schedule",
    sourceThreadId,
    resultsThreadId: routine.resultsThreadId,
    createdAt: deps.now(),
  };
  return run;
}

export function discardResultsThreads(
  allocations: ResultsThreadAllocation[],
  options: RoutineManagerOptions,
) {
  for (const { botId, threadId } of allocations) {
    try {
      options.discardResultsThread?.(botId, threadId);
    } catch (error) {
      console.error("routine: could not discard uncommitted results thread", error);
    }
  }
}
