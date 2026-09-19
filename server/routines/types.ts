// Public type layer for routines: schedule shapes, routine/run records,
// and request-receipt identities shared across the routines modules.
import type { GroupGoalRunStatus } from "../../shared/group-goal-run.ts";
import type { RoutineRequestOperation } from "../../shared/routine-request.ts";
import type { RoutineCronSchedule } from "../../shared/routine-schedule.ts";

export interface RoutineIntervalWindow {
  start: string;
  end: string;
}

export interface RoutineIntervalSchedule {
  type: "interval";
  everyMinutes: number;
  anchorAt: number;
  /** Local weekdays (`0` is Sunday). Missing means every day. */
  weekdays?: number[];
  /** Local, same-day wall-clock window. Missing means all day. */
  window?: RoutineIntervalWindow;
  /** Inclusive epoch-millisecond cutoff. Missing means the series never ends. */
  endsAt?: number;
}

/** Input-only nullable restrictions let current clients deliberately clear a
 * restriction while an omitted field remains distinguishable for legacy
 * clients that know only the interval cadence and anchor. */
export type RoutineIntervalScheduleInput = Omit<RoutineIntervalSchedule, "weekdays" | "window" | "endsAt"> & {
  weekdays?: number[] | null;
  window?: RoutineIntervalWindow | null;
  endsAt?: number | null;
};

export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] }
  | RoutineCronSchedule
  | RoutineIntervalSchedule;

export type RoutineScheduleInput =
  | Exclude<RoutineSchedule, RoutineIntervalSchedule>
  | RoutineIntervalScheduleInput;


/** `cloud` runs the agent itself inside the bot's Box VM. `maus` keeps
 * using the provider selected on the MAUS and only borrows its configured
 * computer tools, if any. */
export type RoutineRunOn = "maus" | "cloud";
export type RoutineTarget = "bot" | "room-goal";
export type RoutineGoalStatus = Exclude<GroupGoalRunStatus, "working">;

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
  /** A bot routine's owner, or the lead coordinator for a room goal. */
  botId: string;
  groupId?: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  /** Legacy calendar/display length. Kept for persisted-data compatibility. */
  durationMinutes: number;
  /** Optional safety cap for active work. Missing means no timeout. */
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  /** Carry the previous run's report into the next run's prompt, so recurring
   * work builds on itself instead of restarting cold. Optional so existing
   * files migrate in place. */
  continuity?: boolean;
  /** Conversation that created this routine in chat. Calendar/import-created
   * routines intentionally have no source, and older files migrate in place. */
  sourceThreadId?: string;
  /** Stable visible report destination; execution still gets a fresh task. */
  resultsThreadId?: string;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  /** Snapshot the work so an edited/deleted definition cannot rewrite history. */
  prompt?: string;
  /** Snapshot of the legacy calendar/display length. */
  durationMinutes?: number;
  /** Snapshot of the optional active-work safety cap. */
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  target: RoutineTarget;
  /** Exact terminal room outcome. `status` remains the scheduler lifecycle
   * while this preserves blocked/needs-input/limit semantics and closes the
   * cross-file crash-recovery gap with the room's goal card. */
  goalStatus?: RoutineGoalStatus;
  /** Snapshot the room as well as the coordinator so edited definitions do
   * not redirect already-queued team work. */
  groupId?: string;
  botId: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  /** First tick a queued run was skipped because its target bot or room was
   * busy. Deferral behind a busy target is unbounded, so this timestamp is
   * what surfaces the wait instead of leaving the run looking freshly queued. */
  deferredAt?: number;
  /** When the one-per-run deferral notice was raised, so restarts and repeat
   * ticks stay quiet. */
  deferredNoticeAt?: number;
  /** Why this receipt exists. Kept optional so version-1 files migrate in place. */
  triggerSource?: RoutineRunTrigger;
  webhookId?: string;
  deliveryId?: string;
  /** Snapshot the routine's reporting destination. Execution remains on the
   * separate `threadId` so recurring work never contaminates chat context. */
  sourceThreadId?: string;
  /** Snapshot of the chosen destination, never redirected by later edits. */
  resultsThreadId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  /** Human-readable reason the detached execution is waiting. */
  attention?: string;
  error?: string;
  cost?: number | null;
  denials?: string[];
  createdAt: number;
  seenAt?: number;
}

export interface RoutineRequestReceipt {
  requestId: string;
  messageId: string;
  botId: string;
  threadId: string;
  action: RoutineRequestOperation["action"];
  fingerprintVersion: 1;
  /** SHA-256 of the strict normalized operation carried by the card. */
  fingerprint: string;
  resultId: string;
  appliedAt: number;
}

export interface RoutineRequestCommit {
  requestId: string;
  messageId: string;
  botId: string;
  threadId: string;
  action: RoutineRequestOperation["action"];
  fingerprintVersion: 1;
  fingerprint: string;
}

export interface RoutineInput {
  name: string;
  prompt: string;
  target?: RoutineTarget;
  botId: string;
  /** `null` deliberately clears a room when changing the target back to a bot. */
  groupId?: string | null;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineScheduleInput;
  durationMinutes?: number;
  /** `null` deliberately removes an existing safety cap. */
  timeoutMinutes?: number | null;
  attachments?: RoutineContextAttachment[];
  continuity?: boolean;
  /** Omission preserves routing; null creates a new dedicated results task. */
  resultsThreadId?: string | null;
}

export type RoutineRequestOwner = Pick<RoutineRequestReceipt, "requestId" | "messageId" | "botId" | "threadId">;

