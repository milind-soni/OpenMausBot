/** Routine wire shapes: the routine and run records as they ride the REST
 * snapshot and the `routine` / `routine.run` live frames. */
import type { RoutineCronSchedule } from "./routine-schedule.ts";

export interface RoutineIntervalWindow {
  start: string;
  end: string;
}

export type RoutineSchedule =
  | RoutineCronSchedule
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] }
  | {
    type: "interval";
    everyMinutes: number;
    anchorAt: number;
    /** Local weekdays (Sunday = 0). Missing means every day. */
    weekdays?: number[];
    /** Local wall-clock window. Missing means all day. */
    window?: RoutineIntervalWindow;
    /** Inclusive epoch-millisecond cutoff. Missing means never. */
    endsAt?: number;
  };

export type RoutineScheduleInput =
  | Extract<RoutineSchedule, { type: "once" | "daily" | "cron" }>
  | {
    type: "interval";
    everyMinutes: number;
    anchorAt: number;
    /** `null` explicitly restores the every-day default on updates. */
    weekdays?: number[] | null;
    /** `null` explicitly restores the all-day default on updates. */
    window?: RoutineIntervalWindow | null;
    /** `null` explicitly removes an existing end date on updates. */
    endsAt?: number | null;
  };

export type RoutineRunOn = "maus" | "cloud";

export type RoutineTarget = "bot" | "room-goal";
export type RoutineGoalStatus =
  | "completed"
  | "needs-input"
  | "blocked"
  | "limit-reached"
  | "paused"
  | "stopped"
  | "failed";

export interface RoutineContextAttachment {
  id: string;
  kind: "file" | "image";
  name: string;
  path: string;
  size: number;
}

export type RoutineRunTrigger = "schedule" | "manual" | "webhook" | "startup";

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "missed";

/** Why a run started a second time by itself: its engine stalled, OpenMausBot
 * restarted while it ran, the provider rate-limited it or failed for a moment,
 * or it waited for its engine's usage limit to reset. A run gets one. */
export type RoutineRetryCause = "stalled" | "restarted" | "rate_limited" | "provider" | "usage_limit";

/** The statuses both failure indicators count: a run that went wrong and has
 * not been acknowledged. */
export const ROUTINE_PROBLEM_STATUSES: readonly RoutineRunStatus[] = ["failed", "missed"];

export function isRoutineProblemRun(run: { status: RoutineRunStatus }): boolean {
  return ROUTINE_PROBLEM_STATUSES.includes(run.status);
}

/** The logs view's status filter: every run, the composite problem set the
 * indicators count, or one exact status. */
export type RoutineRunStatusFilter = "all" | "problems" | RoutineRunStatus;

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  target: RoutineTarget;
  botId: string;
  groupId?: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  durationMinutes: number;
  /** Optional wall-clock safety limit. Missing means the run is unlimited. */
  timeoutMinutes?: number;
  overlap?: "skip" | "queue";
  /** Each run starts with the previous run's report. */
  continuity?: boolean;
  /** Also run once each time OpenMausBot starts. */
  runOnStartup?: boolean;
  skippedRuns?: number;
  lastSkippedAt?: number;
  failureStreak?: number;
  /** Runs that finished in the last seven days, and how many of them completed. */
  weekRuns?: { ok: number; total: number };
  /** A plain sentence when the routine names a path that cannot exist on the computer that runs it. */
  warning?: string;
  attachments?: RoutineContextAttachment[];
  sourceThreadId?: string;
  resultsThreadId?: string;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  prompt?: string;
  durationMinutes?: number;
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  target: RoutineTarget;
  goalStatus?: RoutineGoalStatus;
  botId: string;
  groupId?: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  triggerSource?: RoutineRunTrigger;
  /** "app": a connected-app event started it; triggerSource is then "webhook" (an outside event). */
  eventSource?: "app";
  webhookId?: string;
  deliveryId?: string;
  /** Room task created for a team-goal run. */
  executionThreadId?: string;
  sourceThreadId?: string;
  resultsThreadId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  /** Set when the run used its one automatic second start, and why. */
  retried?: RoutineRetryCause;
  /** Concise, redacted question or approval reason while status is waiting,
   * or why a queued run starts later. */
  attention?: string;
  cost?: number | null;
  denials?: string[];
  createdAt: number;
  seenAt?: number;
}

export interface RoutineInput {
  name: string;
  prompt: string;
  target?: RoutineTarget;
  botId: string;
  groupId?: string | null;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineScheduleInput;
  durationMinutes?: number;
  /** `null` explicitly removes the limit; omission preserves it on updates. */
  timeoutMinutes?: number | null;
  overlap?: "skip" | "queue";
  /** Each run starts with the previous run's report. */
  continuity?: boolean;
  runOnStartup?: boolean;
  attachments?: RoutineContextAttachment[];
  /** Omission preserves routing; null resets it to the bot's main thread. */
  resultsThreadId?: string | null;
}
