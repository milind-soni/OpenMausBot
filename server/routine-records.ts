// The routine and run records RoutineManager keeps in routines.json; server/routines.ts re-exports them.
import type { RoutineRequestOperation } from "../shared/routine-request.ts";
import type { GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import type { ModelSelection } from "../shared/wire.ts";
import type {
  RoutineAccess, RoutineCheck, RoutineContextAttachment, RoutineDelivery, RoutineHoldCause, RoutineRetryCause, RoutineRunReport, RoutineRunStatus,
  RoutineRunTrigger, RoutineStep, RoutineStepRun,
} from "../shared/routines.ts";
import type { PartPair, RoutinePart } from "./package-parts.ts";
import type { RoutineLineCodes, RoutineTroubleCode } from "./routine-lines.ts";
import type { RoutineSchedule, RoutineScheduleInput } from "./routine-schedules.ts";
import type { RoutineRunAsk } from "./routine-waits.ts";

/** `cloud` runs the agent inside the bot's Boat VM; `maus` runs the bot's own provider and borrows only its computer tools. */
export type RoutineRunOn = "maus" | "cloud";
export type RoutineTarget = "bot" | "room-goal";
export type RoutineGoalStatus = Exclude<GroupGoalRunStatus, "working">;


export interface Routine extends RoutineTroubleCode {
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
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  continuity?: boolean;
  modelSelection?: ModelSelection;
  overlap?: "skip" | "queue";
  runOnStartup?: boolean;
  checks?: RoutineCheck[];
  access?: RoutineAccess;
  deliver?: RoutineDelivery;
  checkedAt?: number;
  checkTrouble?: string;
  wakeAt?: number;
  skippedRuns?: number;
  lastSkippedAt?: number;
  failureStreak?: number;
  weekRuns?: { ok: number; total: number };
  warning?: string;
  heldFor?: RoutineHoldCause;
  steps?: RoutineStep[];
  sourceThreadId?: string;
  resultsThreadId?: string;
  installedPackage?: RoutinePackageStamp;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutinePackageStamp {
  installId: string;
  key: string;
  parts: Record<RoutinePart, PartPair>;
}

export interface RoutineRun extends RoutineLineCodes {
  id: string;
  routineId: string;
  routineName: string;
  prompt?: string;
  durationMinutes?: number;
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  target: RoutineTarget;
  goalStatus?: RoutineGoalStatus;
  groupId?: string;
  botId: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  deferredAt?: number;
  deferredNoticeAt?: number;
  /** A queued run starts no earlier than this. */
  retryAt?: number;
  retried?: RoutineRetryCause;
  /** When its current wait began; read only while the run is waiting. */
  waitingSince?: number;
  asked?: RoutineRunAsk;
  /** Time spent waiting on the person's answers, which the run limit does not count. */
  waitedMs?: number;
  triggerSource?: RoutineRunTrigger;
  /** "app": a connected-app event started it; "wait": a wait's follow-up did (its triggerSource stays "webhook", an outside event). */
  eventSource?: "app" | "wait";
  webhookId?: string;
  deliveryId?: string;
  sourceThreadId?: string;
  resultsThreadId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  attention?: string;
  error?: string; partial?: boolean;
  cost?: number | null;
  denials?: string[];
  report?: RoutineRunReport;
  access?: RoutineAccess;
  deliver?: RoutineDelivery;
  checkKey?: string;
  plan?: RoutineStep[];
  stepAt?: number;
  stepRuns?: RoutineStepRun[];
  handoff?: string;
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
  groupId?: string | null;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineScheduleInput;
  durationMinutes?: number;
  timeoutMinutes?: number | null;
  attachments?: RoutineContextAttachment[];
  continuity?: boolean;
  modelSelection?: ModelSelection | null;
  overlap?: "skip" | "queue";
  runOnStartup?: boolean;
  checks?: RoutineCheck[] | null;
  access?: RoutineAccess | null;
  deliver?: RoutineDelivery | null;
  steps?: RoutineStep[] | null;
  resultsThreadId?: string | null;
}
