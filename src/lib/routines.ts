export interface RoutineIntervalWindow {
  start: string;
  end: string;
}

export type RoutineSchedule =
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
  | Extract<RoutineSchedule, { type: "once" | "daily" }>
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

export type RoutineRunTrigger = "schedule" | "manual" | "webhook";

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "missed";

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
  attachments?: RoutineContextAttachment[];
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
  webhookId?: string;
  deliveryId?: string;
  /** Room task created for a team-goal run. */
  executionThreadId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  /** Concise, redacted question or approval reason while status is waiting. */
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
  attachments?: RoutineContextAttachment[];
}
