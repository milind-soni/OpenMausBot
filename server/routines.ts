import type { Routine, RoutineRun, RoutineRunOn, RoutineRunTrigger } from "./routines/types.ts";

export { ROUTINE_DEFERRAL_NOTICE_MS, RoutineManager } from "./routines/manager.ts";
export { RoutineScheduleError, nextOccurrence } from "./routines/schedule.ts";
export type {
  Routine,
  RoutineContextAttachment,
  RoutineGoalStatus,
  RoutineInput,
  RoutineIntervalSchedule,
  RoutineIntervalScheduleInput,
  RoutineIntervalWindow,
  RoutineRequestCommit,
  RoutineRequestOwner,
  RoutineRequestReceipt,
  RoutineRun,
  RoutineRunOn,
  RoutineRunStatus,
  RoutineRunTrigger,
  RoutineSchedule,
  RoutineScheduleInput,
  RoutineTarget,
} from "./routines/types.ts";

export interface RoutineManagerOptions {
  file?: string;
  now?: () => number;
  /** Keyed frames only: every payload on this bus is `{ kind, … }`, which
   * is what lets the server number and replay them. */
  emit?: (payload: Record<string, unknown>) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  goalState?: (groupId: string, coordinatorBotId: string) => "ready" | "busy" | "missing";
  createTask: (botId: string, title: string, activate?: boolean) => { threadId: string } | null;
  createGoalTask?: (groupId: string, title: string) => { threadId: string } | null;
  isResultsThread?: (botId: string, threadId: string) => boolean;
  /** Reuse routine.resultsThreadId, keep a trusted chat source, or allocate a new ID. */
  resolveResultsThread?: (routine: Routine, forceNew: boolean) => string | undefined;
  /** Compensate an uncommitted allocation, only while still empty. */
  discardResultsThread?: (botId: string, threadId: string) => void;
  startTurn: (
    botId: string,
    threadId: string,
    prompt: string,
    runOn: RoutineRunOn,
    triggerSource: RoutineRunTrigger,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  startGoal?: (
    groupId: string,
    threadId: string,
    prompt: string,
    coordinatorBotId: string,
    runId: string,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  interruptTurn?: (botId: string, threadId: string, runOn: RoutineRunOn) => Promise<void>;
  interruptGoal?: (
    groupId: string,
    threadId: string,
    outcome?: { status: "stopped" | "limit-reached"; detail: string },
  ) => Promise<void>;
  /** Projects every durable transition into the source conversation. */
  onRunChanged?: (run: RoutineRun) => void;
  onRunFailed?: (run: RoutineRun) => void;
  /** Raised once when a queued run has waited out the deferral notice window. */
  onRunDeferred?: (run: RoutineRun) => void;
  /** A successful provider turn is intermediate while its peer work or
   * queued continuation still belongs to this detached execution. */
  hasPendingDelegations?: (threadId: string) => boolean;
}
