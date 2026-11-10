import { cloneAttachments } from "./routine-attachments.ts";
import { cloneSchedule } from "./routine-schedules.ts";
import type { Routine, RoutineManagerOptions, RoutineRequestOwner, RoutineRun } from "./routines.ts";

export type ResultsThreadAllocation = { botId: string; threadId: string };

export function routineRequestOwnerKey(owner: RoutineRequestOwner): string {
  return JSON.stringify([owner.requestId, owner.messageId, owner.botId, owner.threadId]);
}

export function cloneRoutine(routine: Routine): Routine {
  return { ...routine, schedule: cloneSchedule(routine.schedule), attachments: cloneAttachments(routine.attachments) };
}

export function cloneRun(run: RoutineRun): RoutineRun {
  return { ...run, attachments: cloneAttachments(run.attachments), denials: run.denials ? [...run.denials] : undefined };
}

export function pauseFailedWorkflow(run: RoutineRun, routines: Routine[]): Routine | undefined {
  if (run.executionMode !== "minimum-ai") return undefined;
  const routine = routines.find((item) => item.id === run.routineId);
  if (!routine || !routine.enabled) return undefined;
  routine.enabled = false;
  routine.nextRunAt = null;
  return routine;
}

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

export function routineRunDefinition(routine: Routine): Pick<RoutineRun,
  "executionMode" | "routineName" | "prompt" | "durationMinutes" | "timeoutMinutes" | "attachments" | "target" | "groupId" | "botId" | "runOn" | "access" | "deliver"> {
  return {
    ...(routine.executionMode === "minimum-ai" ? { executionMode: "minimum-ai" as const } : {}),
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
