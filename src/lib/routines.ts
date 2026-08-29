export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] }
  | { type: "interval"; everyMinutes: number; from: string; to: string; weekdays: number[] };

export type RoutineRunOn = "maus" | "cloud";

export type RoutineRunTrigger = "schedule" | "manual" | "webhook";

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "verified"
  | "failed"
  | "cancelled"
  | "skipped"
  | "missed";

export interface RoutineBudget {
  maxScheduledRunsPerDay?: number;
  maxTokensPerDay?: number;
  maxCostUsdPerDay?: number;
}

export interface RoutinePrefilter {
  type: "change-marker";
  sourceIds: string[];
}

export interface RoutineCapabilityPolicy {
  connectedApps?: "inherit" | "off" | "read-only" | "draft-only" | "execute";
  computer?: "inherit" | "off" | "read-only" | "execute";
  peerBots?: "inherit" | "off";
  phone?: "inherit" | "off";
}

export interface RoutineEvidence {
  id: string;
  kind: "test" | "artifact" | "source" | "screen" | "receipt" | "other";
  summary: string;
  reference?: string;
  recordedAt: number;
}

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  durationMinutes: number;
  budget?: RoutineBudget;
  prefilter?: RoutinePrefilter;
  capabilities?: RoutineCapabilityPolicy;
  workLockId?: string;
  maxChangedStrategyRetries?: 0 | 1;
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
  botId: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  triggerSource?: RoutineRunTrigger;
  webhookId?: string;
  deliveryId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  blocker?: string;
  cost?: number | null;
  usage?: { input: number; output: number };
  denials?: string[];
  capabilities?: RoutineCapabilityPolicy;
  workLockId?: string;
  evidence?: RoutineEvidence[];
  retryOf?: string;
  retryCount?: number;
  strategy?: string;
  maxChangedStrategyRetries?: 0 | 1;
  createdAt: number;
  seenAt?: number;
  coalescedThrough?: number;
  coalescedCount?: number;
}

export interface RoutineInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineSchedule;
  durationMinutes?: number;
  budget?: RoutineBudget;
  prefilter?: RoutinePrefilter;
  capabilities?: RoutineCapabilityPolicy;
  workLockId?: string;
  maxChangedStrategyRetries?: 0 | 1;
}
