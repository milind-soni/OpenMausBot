import { cloneAttachments } from "./routine-attachments.ts";
import type { Routine, RoutineManagerOptions, RoutineRun } from "./routines.ts";

export type ResultsThreadAllocation = { botId: string; threadId: string };

export function resolveRoutineResultsThread(
  routine: Routine,
  resolve: RoutineManagerOptions["resolveResultsThread"],
  allocations: ResultsThreadAllocation[],
  now: number,
  sourceThreadId = routine.sourceThreadId,
): string | undefined {
  if (routine.target !== "bot" || !resolve) return routine.resultsThreadId;
  const destination = resolve({ ...routine, sourceThreadId }, false);
  const own = destination?.main ? undefined : destination?.threadId;
  if (own !== routine.resultsThreadId) {
    if (own) allocations.push({ botId: routine.botId, threadId: own });
    if (own) routine.resultsThreadId = own;
    else delete routine.resultsThreadId;
    routine.updatedAt = Math.max(now, routine.updatedAt + 1);
  }
  return destination?.threadId;
}

export function chatOfOneTimeRoutine(
  { schedule, botId, sourceThreadId }: Routine,
  options: Pick<RoutineManagerOptions, "oneTimeReportsToItsChat" | "isResultsThread">,
): string | undefined {
  const oneTime = schedule.type === "once" || (schedule.type === "limit_reset" && schedule.repeat === "once");
  return oneTime && sourceThreadId && options.oneTimeReportsToItsChat && options.isResultsThread?.(botId, sourceThreadId) ? sourceThreadId : undefined;
}

export function discardResultsThreads(allocations: ResultsThreadAllocation[], discard: RoutineManagerOptions["discardResultsThread"]) {
  for (const { botId, threadId } of allocations) {
    try {
      discard?.(botId, threadId);
    } catch (error) {
      console.error("routine: could not discard uncommitted results thread", error);
    }
  }
}

export function routineRunDefinition(routine: Routine): Pick<RoutineRun,
  "routineName" | "prompt" | "durationMinutes" | "timeoutMinutes" | "attachments" | "target" | "groupId" | "botId" | "runOn" | "access" | "deliver"> {
  return {
    routineName: routine.name,
    prompt: routine.prompt,
    durationMinutes: routine.durationMinutes,
    ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
    attachments: cloneAttachments(routine.attachments),
    target: routine.target,
    groupId: routine.groupId,
    botId: routine.botId,
    runOn: routine.runOn ?? "maus",
    access: routine.access,
    deliver: routine.deliver,
  };
}
