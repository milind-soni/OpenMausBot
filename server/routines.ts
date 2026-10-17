import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { writeFileAtomic } from "./atomic.ts";
import { redactSecretsInText } from "./redact.ts";
import type { GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import type { RoutineRequestOperation } from "../shared/routine-request.ts";
import { normalizeCronSchedule, nextCronRuns, type RoutineCronSchedule } from "../shared/routine-schedule.ts";
import {
  isRoutineProblemRun, type RoutineContextAttachment, type RoutineIntervalWindow, type RoutineRetryCause, type RoutineRunStatus, type RoutineRunTrigger,
} from "../shared/routines.ts";
import { ROUTINE_PARTS, type PartPair, type RoutinePart } from "./package-parts.ts";
import {
  composeExecutionPrompt, continuityCarry, ROUTINE_DEFERRAL_NOTICE_MS, ROUTINE_SKIPPED_WHILE_WAITING, ROUTINE_SUPERSEDED,
  routineFailure, routineHostWarning, skipNeedsNotice, supersededBy,
} from "./routine-execution.ts";
import {
  dispatchRefusal, engineFacts, loadOwnerNotices, recoverRun, requeueOnce, weekRuns, type RoutineAlert, type RoutineFailureFacts, type RoutineOwnerNotice,
} from "./routine-recovery.ts";
import { activeMs, askOf, settleAsk, waitingFor, type RoutineRunAsk } from "./routine-waits.ts";
import { EVENT_RETRY_WINDOW_MS, loadEventReceipts, MAX_EVENT_RECEIPTS, type EventRunReceipt } from "./routine-event-receipts.ts";

export type { RoutineContextAttachment, RoutineIntervalWindow, RoutineRunStatus, RoutineRunTrigger };

export interface RoutineIntervalSchedule {
  type: "interval";
  everyMinutes: number;
  anchorAt: number;
  /** Local weekdays (`0` is Sunday). Missing means every day. */
  weekdays?: number[];
  window?: RoutineIntervalWindow;
  endsAt?: number;
}

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

/** `cloud` runs the agent inside the bot's Boat VM; `maus` runs the bot's own provider and borrows only its computer tools. */
export type RoutineRunOn = "maus" | "cloud";
export type RoutineTarget = "bot" | "room-goal";
export type RoutineGoalStatus = Exclude<GroupGoalRunStatus, "working">;

const persistedSourceThreadId = z.string().trim().min(1).optional().catch(undefined);

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
  timeoutMinutes?: number;
  attachments?: RoutineContextAttachment[];
  continuity?: boolean;
  overlap?: "skip" | "queue";
  runOnStartup?: boolean;
  skippedRuns?: number;
  lastSkippedAt?: number;
  failureStreak?: number;
  weekRuns?: { ok: number; total: number };
  warning?: string;
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

const HASH = /^[a-f0-9]{64}$/;
function loadInstalledPackage(value: unknown): RoutinePackageStamp | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stamp = value as Partial<RoutinePackageStamp>;
  if (typeof stamp.installId !== "string" || !/^[a-f0-9]{32}$/.test(stamp.installId) || typeof stamp.key !== "string" || !stamp.key || stamp.key.length > 80) return undefined;
  const parts = stamp.parts as Record<string, Partial<PartPair>> | undefined;
  if (!parts || typeof parts !== "object" || !ROUTINE_PARTS.every((part) => HASH.test(String(parts[part]?.r)) && HASH.test(String(parts[part]?.w)))) return undefined;
  return {
    installId: stamp.installId,
    key: stamp.key,
    parts: Object.fromEntries(ROUTINE_PARTS.map((part) => [part, { r: parts[part]!.r!, w: parts[part]!.w! }])) as Record<RoutinePart, PartPair>,
  };
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
  /** "app": a connected-app event started it (its triggerSource stays "webhook", an outside event). */
  eventSource?: "app";
  webhookId?: string;
  deliveryId?: string;
  sourceThreadId?: string;
  resultsThreadId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
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

type RoutineRequestCommitFor<Action extends RoutineRequestOperation["action"]> =
  Omit<RoutineRequestCommit, "action"> & { action: Action };

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
  overlap?: "skip" | "queue";
  runOnStartup?: boolean;
  resultsThreadId?: string | null;
}

interface RoutineFile {
  version: 1;
  frozenResultsCleared?: true;
  routines: Routine[];
  runs: RoutineRun[];
  routineRequestReceipts?: RoutineRequestReceipt[];
  webhookRunReceipts?: EventRunReceipt[];
  startupLaunchId?: string;
  ownerNotices?: RoutineOwnerNotice[];
}


export type RoutineRequestOwner = Pick<RoutineRequestReceipt, "requestId" | "messageId" | "botId" | "threadId">;

type ResultsThreadAllocation = { botId: string; threadId: string };

function routineRequestOwnerKey(owner: RoutineRequestOwner): string {
  return JSON.stringify([owner.requestId, owner.messageId, owner.botId, owner.threadId]);
}

export interface RoutineManagerOptions {
  file?: string;
  now?: () => number;
  /** Every payload must be `{ kind, … }`: the server numbers and replays frames by it. */
  emit?: (payload: Record<string, unknown>) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  goalState?: (groupId: string, coordinatorBotId: string) => "ready" | "busy" | "missing";
  createTask: (botId: string, title: string, activate?: boolean, run?: RoutineRun) => { threadId: string } | null;
  joinConversation?: (run: RoutineRun) => string | null;
  createGoalTask?: (groupId: string, title: string) => { threadId: string } | null;
  isResultsThread?: (botId: string, threadId: string) => boolean;
  resolveResultsThread?: (routine: Routine, forceNew: boolean) => { threadId: string; main?: true } | undefined;
  frozenResultsThread?: (botId: string, threadId: string) => boolean;
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
  interruptTurn?: (botId: string, threadId: string) => Promise<void>;
  interruptGoal?: (
    groupId: string,
    threadId: string,
    outcome?: { status: "stopped" | "limit-reached"; detail: string },
  ) => Promise<void>;
  onRunChanged?: (run: RoutineRun) => void;
  onRunFailed?: (run: RoutineRun, alert?: RoutineAlert | null) => void;
  onRunDeferred?: (run: RoutineRun, alert?: RoutineAlert) => void;
  /** A run a restart cut off, before it starts again or fails: its old turn's work must not resume as well. */
  onRunCut?: (run: RoutineRun) => void;
  hasPendingDelegations?: (threadId: string) => boolean;
  /** Work this thread handed to another bot is still open, so its wait is not only on the person. */
  handedOffWorkLive?: (threadId: string) => boolean;
  launchId?: string;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const CATCH_UP_MS = 12 * 60 * 60_000;
const WAKE_HORIZON_MS = 60 * 60_000;

export const ROUTINE_RESTARTED = "OpenMausBot restarted while this routine was running";
const MAX_DATE_MS = 8_640_000_000_000_000;
const LOCAL_DAY_MS = 24 * 60 * 60_000;
const INTERVAL_RESTRICTION_SEARCH_MS = 9 * LOCAL_DAY_MS;
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_RUNS = 2_000;
const MAX_ATTACHMENTS = 50;
const attachmentSchema = z.object({
  id: z.string().trim().min(1).max(200),
  kind: z.enum(["file", "image"]),
  name: z.string().trim().min(1).max(255),
  path: z.string().trim().min(1).max(4_096),
  size: z.number().finite().nonnegative(),
});
const ROUTINE_REQUEST_ACTIONS = new Set<RoutineRequestOperation["action"]>([
  "create",
  "update",
  "pause",
  "resume",
  "run_now",
  "delete",
]);

function isRoutineRequestAction(value: unknown): value is RoutineRequestOperation["action"] {
  return typeof value === "string" && ROUTINE_REQUEST_ACTIONS.has(value as RoutineRequestOperation["action"]);
}

function cleanDays(days: unknown): number[] {
  if (!Array.isArray(days)) return ALL_DAYS;
  const out = [...new Set(days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return out.length ? out : ALL_DAYS;
}

function cleanAttachments(value: unknown): RoutineContextAttachment[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    throw new Error(`Add no more than ${MAX_ATTACHMENTS} attachments`);
  }
  const ids = new Set<string>();
  return value.map((candidate) => {
    const parsed = attachmentSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.name.includes("\0") || parsed.data.path.includes("\0")) {
      throw new Error("Choose a valid attachment");
    }
    if (ids.has(parsed.data.id)) throw new Error("Each attachment must be unique");
    ids.add(parsed.data.id);
    return { ...parsed.data };
  });
}

function cleanTimeoutMinutes(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 5 || value > 240) {
    throw new Error("Run limit must be a whole number from 5 to 240 minutes");
  }
  return value;
}

function loadTimeoutMinutes(value: unknown): number | undefined {
  try {
    return cleanTimeoutMinutes(value);
  } catch {
    return undefined;
  }
}

function loadAttachments(value: unknown): RoutineContextAttachment[] {
  try {
    return cleanAttachments(value);
  } catch {
    return [];
  }
}

function cloneSchedule(schedule: RoutineSchedule): RoutineSchedule {
  if (schedule.type === "once") return { type: "once", at: schedule.at };
  if (schedule.type === "cron") return { ...schedule };
  if (schedule.type === "interval") {
    return {
      type: "interval",
      everyMinutes: schedule.everyMinutes,
      anchorAt: schedule.anchorAt,
      ...(schedule.weekdays ? { weekdays: [...schedule.weekdays] } : {}),
      ...(schedule.window ? { window: { ...schedule.window } } : {}),
      ...(schedule.endsAt === undefined ? {} : { endsAt: schedule.endsAt }),
    };
  }
  return { type: "daily", time: schedule.time, weekdays: [...schedule.weekdays] };
}

function cloneAttachments(attachments: readonly RoutineContextAttachment[] | undefined): RoutineContextAttachment[] {
  return attachments?.map((attachment) => ({ ...attachment })) ?? [];
}

function loadTarget(value: unknown): RoutineTarget {
  return value === "room-goal" ? "room-goal" : "bot";
}

const ROUTINE_GOAL_STATUSES = new Set<RoutineGoalStatus>([
  "completed",
  "needs-input",
  "blocked",
  "limit-reached",
  "paused",
  "stopped",
  "failed",
]);

function loadGoalStatus(value: unknown, target: RoutineTarget): RoutineGoalStatus | undefined {
  return target === "room-goal" && typeof value === "string" && ROUTINE_GOAL_STATUSES.has(value as RoutineGoalStatus)
    ? value as RoutineGoalStatus
    : undefined;
}

function loadGroupId(value: unknown, target: RoutineTarget): string | undefined {
  if (target !== "room-goal" || typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function cloneRoutine(routine: Routine): Routine {
  return {
    ...routine,
    schedule: cloneSchedule(routine.schedule),
    attachments: cloneAttachments(routine.attachments),
  };
}

function cloneRun(run: RoutineRun): RoutineRun {
  return {
    ...run,
    attachments: cloneAttachments(run.attachments),
    denials: run.denials ? [...run.denials] : undefined,
  };
}

function cleanIntervalWeekdays(value: unknown): number[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > ALL_DAYS.length) {
    throw new Error("Choose at least one valid interval day");
  }
  if (value.some((day) => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error("Interval days must be whole numbers from 0 to 6");
  }
  if (new Set(value).size !== value.length) throw new Error("Choose each interval day only once");
  const weekdays = [...value].sort((a, b) => a - b);
  return weekdays.length === ALL_DAYS.length ? undefined : weekdays;
}

function clockMinutes(value: string): number | null {
  const match = CLOCK_TIME.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function cleanIntervalWindow(value: unknown, everyMinutes: number): RoutineIntervalWindow | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Choose a valid interval time window");
  }
  const candidate = value as Partial<RoutineIntervalWindow>;
  const start = typeof candidate.start === "string" ? candidate.start : "";
  const end = typeof candidate.end === "string" ? candidate.end : "";
  const startMinutes = clockMinutes(start);
  const endMinutes = clockMinutes(end);
  if (startMinutes == null || endMinutes == null) {
    throw new Error("Interval window times must use HH:MM");
  }
  if (startMinutes >= endMinutes) {
    throw new Error("Interval window must start before it ends on the same day");
  }
  if (endMinutes - startMinutes < everyMinutes) {
    throw new Error("Interval window must be at least as long as the interval");
  }
  return { start, end };
}

function cleanIntervalEndsAt(value: unknown, anchorAt: number): number | undefined {
  if (value == null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < anchorAt ||
    value > MAX_DATE_MS
  ) {
    throw new Error("Choose a valid interval end time after its start");
  }
  return value;
}

export class RoutineScheduleError extends Error {
  readonly status = 400;
}

function parseSchedule(schedule: RoutineScheduleInput, after: number): RoutineSchedule {
  if (schedule?.type === "cron") return normalizeCronSchedule(schedule, after);
  if (schedule?.type === "once") {
    const at = Number(schedule.at);
    if (!Number.isFinite(at)) throw new Error("Choose a valid date and time");
    return { type: "once", at };
  }
  if (schedule?.type === "daily") {
    const time = String(schedule.time ?? "");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Time must use HH:MM");
    return { type: "daily", time, weekdays: cleanDays(schedule.weekdays) };
  }
  if (schedule?.type === "interval") {
    const { everyMinutes, anchorAt } = schedule;
    if (typeof everyMinutes !== "number" || !Number.isInteger(everyMinutes) || everyMinutes < 5 || everyMinutes > 1_440) {
      throw new Error("Interval must be a whole number from 5 to 1440 minutes");
    }
    if (
      typeof anchorAt !== "number" ||
      !Number.isSafeInteger(anchorAt) ||
      anchorAt < 0 ||
      anchorAt > MAX_DATE_MS
    ) {
      throw new Error("Choose a valid interval start time");
    }
    const weekdays = cleanIntervalWeekdays(schedule.weekdays);
    const window = cleanIntervalWindow(schedule.window, everyMinutes);
    const endsAt = cleanIntervalEndsAt(schedule.endsAt, anchorAt);
    return {
      type: "interval",
      everyMinutes,
      anchorAt,
      ...(weekdays ? { weekdays } : {}),
      ...(window ? { window } : {}),
      ...(endsAt === undefined ? {} : { endsAt }),
    };
  }
  throw new Error("Choose a supported schedule");
}

function cleanSchedule(schedule: RoutineScheduleInput, after: number): RoutineSchedule {
  try { return parseSchedule(schedule, after); }
  catch (error) { throw new RoutineScheduleError((error as Error).message); }
}

function loadSchedule(value: unknown, after: number): RoutineSchedule | null {
  try {
    return cleanSchedule(value as RoutineScheduleInput, after);
  } catch {
    return null;
  }
}

export function intervalHasRestrictions(
  schedule: Pick<RoutineIntervalSchedule, "weekdays" | "window" | "endsAt">,
): boolean {
  return schedule.weekdays !== undefined || schedule.window !== undefined || schedule.endsAt !== undefined;
}

function intervalAllowsOccurrence(schedule: RoutineIntervalSchedule, at: number): boolean {
  if (schedule.endsAt !== undefined && at > schedule.endsAt) return false;
  const date = new Date(at);
  if (schedule.weekdays && !schedule.weekdays.includes(date.getDay())) return false;
  if (schedule.window) {
    const minute = date.getHours() * 60 + date.getMinutes();
    const start = clockMinutes(schedule.window.start)!;
    const end = clockMinutes(schedule.window.end)!;
    if (minute < start || minute >= end) return false;
  }
  return true;
}

function isSameLocalDay(left: number, right: number): boolean {
  const a = new Date(left);
  const b = new Date(right);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function nextAlignedInterval(schedule: RoutineIntervalSchedule, after: number): number | null {
  if (schedule.anchorAt > after) return schedule.anchorAt;
  const intervalMs = schedule.everyMinutes * 60_000;
  const intervalsElapsed = Math.floor((after - schedule.anchorAt) / intervalMs);
  const candidate = schedule.anchorAt + (intervalsElapsed + 1) * intervalMs;
  return Number.isSafeInteger(candidate) && candidate <= MAX_DATE_MS ? candidate : null;
}

export function nextOccurrence(schedule: RoutineSchedule, after: number): number | null {
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.type === "cron") return nextCronRuns(schedule, after, 1)[0] ?? null;
  if (schedule.type === "interval") {
    const intervalMs = schedule.everyMinutes * 60_000;
    let candidate = nextAlignedInterval(schedule, after);
    if (!intervalHasRestrictions(schedule)) return candidate;
    const maxCandidates = Math.ceil(INTERVAL_RESTRICTION_SEARCH_MS / intervalMs) + 2;
    for (let checked = 0; candidate !== null && checked < maxCandidates; checked++) {
      if (schedule.endsAt !== undefined && candidate > schedule.endsAt) return null;
      if (intervalAllowsOccurrence(schedule, candidate)) return candidate;
      const next = candidate + intervalMs;
      candidate = Number.isSafeInteger(next) && next <= MAX_DATE_MS ? next : null;
    }
    return null;
  }
  const [hour, minute] = schedule.time.split(":").map(Number);
  const weekdays = new Set(cleanDays(schedule.weekdays));
  for (let offset = 0; offset <= 8; offset++) {
    const d = new Date(after);
    d.setDate(d.getDate() + offset);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() > after && weekdays.has(d.getDay())) return d.getTime();
  }
  return null;
}

function latestIntervalOccurrence(
  schedule: RoutineIntervalSchedule,
  at: number,
): number | null {
  const intervalMs = schedule.everyMinutes * 60_000;
  const ceiling = Math.min(at, schedule.endsAt ?? at);
  if (schedule.anchorAt > ceiling) return null;
  let candidate = schedule.anchorAt + Math.floor((ceiling - schedule.anchorAt) / intervalMs) * intervalMs;
  if (!intervalHasRestrictions(schedule)) return candidate;
  const maxCandidates = Math.ceil(INTERVAL_RESTRICTION_SEARCH_MS / intervalMs) + 2;
  for (let checked = 0; checked < maxCandidates; checked++) {
    if (intervalAllowsOccurrence(schedule, candidate)) return candidate;
    const previous = candidate - intervalMs;
    if (!Number.isSafeInteger(previous) || previous < schedule.anchorAt) return null;
    candidate = previous;
  }
  return null;
}

function mergeScheduleUpdate(
  current: RoutineSchedule,
  incoming: RoutineScheduleInput,
): RoutineScheduleInput {
  if (current.type !== "interval" || incoming.type !== "interval") return incoming;
  const merged: RoutineIntervalScheduleInput = { ...incoming };
  if (!Object.hasOwn(incoming, "weekdays") && current.weekdays) {
    merged.weekdays = [...current.weekdays];
  }
  if (!Object.hasOwn(incoming, "window") && current.window) {
    merged.window = { ...current.window };
  }
  if (!Object.hasOwn(incoming, "endsAt") && current.endsAt !== undefined) {
    merged.endsAt = current.endsAt;
  }
  return merged;
}

function sanitizeInput(input: RoutineInput, after: number): Omit<Routine, "id" | "createdAt" | "updatedAt" | "nextRunAt"> {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const prompt = String(input.prompt ?? "").trim().slice(0, 20_000);
  const botId = String(input.botId ?? "").trim();
  if (!name) throw new Error("Give the routine a name");
  if (!prompt) throw new Error("Tell the bot what to do");
  if (!botId) throw new Error("Choose a bot");
  const target = input.target ?? "bot";
  if (target !== "bot" && target !== "room-goal") throw new Error("Choose a valid routine target");
  const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
  if (target === "room-goal" && !groupId) throw new Error("Choose a room for this goal");
  const runOn = input.runOn ?? "maus";
  if (runOn !== "maus" && runOn !== "cloud") throw new Error("Choose where this routine runs");
  const attachments = cleanAttachments(input.attachments);
  const timeoutMinutes = cleanTimeoutMinutes(input.timeoutMinutes);
  if (target === "room-goal" && runOn === "cloud") {
    throw new Error("Room goals can only run on this computer");
  }
  if (target === "room-goal" && attachments.length > 0) {
    throw new Error("Room goals do not support attachments yet");
  }
  if (runOn === "cloud" && attachments.length > 0) {
    throw new Error("Attachments can only run on this computer until cloud file staging is available");
  }
  const continuity = input.continuity === true;
  if (input.overlap !== undefined && input.overlap !== "skip" && input.overlap !== "queue") {
    throw new Error("Choose skip or queue for overlapping runs");
  }
  if (continuity && target === "room-goal") {
    throw new Error("Room goals do not carry continuity yet");
  }
  const schedule = cleanSchedule(input.schedule, after);
  return {
    name,
    prompt,
    target,
    botId,
    groupId: target === "room-goal" ? groupId : undefined,
    runOn,
    enabled: input.enabled !== false,
    schedule,
    durationMinutes: Math.min(240, Math.max(5, Math.round(Number(input.durationMinutes) || 30))),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    attachments,
    ...(continuity ? { continuity: true } : {}),
    ...(input.overlap === "queue" ? { overlap: "queue" as const } : {}),
    ...(input.runOnStartup === true && schedule.type !== "once" ? { runOnStartup: true } : {}),
  };
}

export class RoutineManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: RoutineManagerOptions;
  private routines: Routine[] = [];
  /** Written back unchanged on every save, so unrelated work never deletes a repairable row. */
  private unloadedRoutines: Routine[] = [];
  private runs: RoutineRun[] = [];
  private routineRequestReceipts: RoutineRequestReceipt[] = [];
  private webhookRunReceipts: EventRunReceipt[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupRunsQueued = false;
  private startupLaunchId: string | undefined;
  private ticking = false;
  private closing = false;
  private ownerNotices: RoutineOwnerNotice[] = [];
  private readonly failureFacts = new Map<string, RoutineFailureFacts>();
  /** Saves are refused while set, so an empty state never overwrites an unreadable file. */
  private unreadable = false;
  private frozenPending = false;

  constructor(options: RoutineManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "routines.json");
    this.now = options.now ?? Date.now;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RoutineFile>;
      if (disk === null || typeof disk !== "object" || Array.isArray(disk)) throw new Error("Invalid routines file");
      for (const key of ["routines", "runs", "routineRequestReceipts", "webhookRunReceipts"] as const) {
        if (key in disk && !Array.isArray(disk[key])) throw new Error(`Invalid routines file: ${key} is not a list`);
      }
      this.routines = Array.isArray(disk.routines)
        ? disk.routines.flatMap((routine) => {
            const schedule = loadSchedule(routine.schedule, this.now());
            if (!schedule) {
              console.warn(`routines: keeping ${String(routine.id)} on disk unscheduled; its schedule could not load`);
              this.unloadedRoutines.push(routine);
              return [];
            }
            const target = loadTarget(routine.target);
            const loaded: Routine = {
              ...routine,
              schedule,
              target,
              groupId: loadGroupId(routine.groupId, target),
              runOn: routine.runOn ?? "maus",
              timeoutMinutes: loadTimeoutMinutes(routine.timeoutMinutes),
              attachments: loadAttachments(routine.attachments),
              sourceThreadId: persistedSourceThreadId.parse(routine.sourceThreadId),
              resultsThreadId: persistedSourceThreadId.parse(routine.resultsThreadId),
              overlap: routine.overlap === "queue" ? "queue" : undefined,
              runOnStartup: routine.runOnStartup === true ? true : undefined,
              skippedRuns: Number.isSafeInteger(routine.skippedRuns) && routine.skippedRuns! > 0 ? routine.skippedRuns : undefined,
              lastSkippedAt: Number.isSafeInteger(routine.lastSkippedAt) && routine.lastSkippedAt! >= 0 && routine.lastSkippedAt! <= MAX_DATE_MS ? routine.lastSkippedAt : undefined,
              installedPackage: loadInstalledPackage(routine.installedPackage),
            };
            if (loaded.timeoutMinutes === undefined) delete loaded.timeoutMinutes;
            if (loaded.runOnStartup === undefined) delete loaded.runOnStartup;
            if (loaded.installedPackage === undefined) delete loaded.installedPackage;
            delete loaded.failureStreak;
            return [loaded];
          })
        : [];
      this.runs = Array.isArray(disk.runs)
        ? disk.runs.map((run) => {
            const target = loadTarget(run.target);
            const loaded: RoutineRun = {
              ...run,
              target,
              goalStatus: loadGoalStatus(run.goalStatus, target),
              groupId: loadGroupId(run.groupId, target),
              runOn: run.runOn ?? "maus",
              timeoutMinutes: loadTimeoutMinutes(run.timeoutMinutes),
              attachments: loadAttachments(run.attachments),
              sourceThreadId: persistedSourceThreadId.parse(run.sourceThreadId),
              resultsThreadId: persistedSourceThreadId.parse(run.resultsThreadId),
            };
            if (loaded.timeoutMinutes === undefined) delete loaded.timeoutMinutes;
            return loaded;
          })
        : [];
      this.routineRequestReceipts = Array.isArray(disk.routineRequestReceipts)
        ? disk.routineRequestReceipts.filter((receipt): receipt is RoutineRequestReceipt =>
            typeof receipt?.requestId === "string" &&
            typeof receipt?.messageId === "string" &&
            typeof receipt?.botId === "string" &&
            typeof receipt?.threadId === "string" &&
            isRoutineRequestAction(receipt?.action) &&
            receipt?.fingerprintVersion === 1 &&
            typeof receipt?.fingerprint === "string" && /^[a-f0-9]{64}$/.test(receipt.fingerprint) &&
            typeof receipt?.resultId === "string" &&
            Number.isFinite(receipt?.appliedAt)
          )
        : [];
      this.webhookRunReceipts = loadEventReceipts(disk.webhookRunReceipts, this.runs, this.now());
      this.frozenPending = disk.frozenResultsCleared !== true;
      this.ownerNotices = loadOwnerNotices(disk.ownerNotices);
      if (typeof disk.startupLaunchId === "string") this.startupLaunchId = disk.startupLaunchId;
    } catch (error) {
      this.routines = [];
      this.unloadedRoutines = [];
      this.runs = [];
      this.routineRequestReceipts = [];
      this.webhookRunReceipts = [];
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.unreadable = true;
        // JSON.parse errors can echo a fragment of the input, so they never reach the log.
        const reason = error instanceof SyntaxError ? "invalid JSON"
          : error instanceof Error ? error.message : "unable to read routines";
        console.error(`routines: ignoring unreadable ${this.file}: ${reason}`);
      }
    }
    const cut: RoutineRun[] = [];
    for (const run of this.runs.filter((candidate) => candidate.status === "running" || candidate.status === "waiting")) {
      settleAsk(run, undefined, this.now());
      if (run.threadId && run.target === "bot" && this.options.hasPendingDelegations?.(run.threadId) === true) {
        this.wait(run, "Waiting for delegated work to finish");
        continue;
      }
      if (!requeueOnce(run, "restarted", ROUTINE_RESTARTED, this.now())) {
        Object.assign(run, { status: "failed", error: ROUTINE_RESTARTED, attention: undefined, finishedAt: this.now() } satisfies Partial<RoutineRun>);
        if (run.target === "room-goal") run.goalStatus = "failed";
      }
      cut.push(cloneRun(run));
    }
    if (cut.length > 0) this.save();
    for (const run of cut) {
      if (run.threadId) this.options.onRunCut?.(run);
      this.notifyRunChanged(run);
      if (run.status === "failed") this.options.onRunFailed?.(run);
    }
  }

  listRoutines(): Routine[] {
    return this.routines.map(routine => this.routineWithHealth(routine));
  }

  clearFrozenResultsThreads(): void {
    if (!this.frozenPending) return;
    for (const routine of this.routines) {
      if (routine.target === "bot" && routine.resultsThreadId !== undefined &&
        this.options.frozenResultsThread?.(routine.botId, routine.resultsThreadId)) delete routine.resultsThreadId;
    }
    this.frozenPending = false;
    this.save();
  }

  private routineWithHealth(routine: Routine): Routine {
    const outcomes = this.runs.filter(run => run.routineId === routine.id && (run.status === "failed" || run.status === "completed")).reverse()
      .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt) || b.createdAt - a.createdAt);
    const success = outcomes.findIndex(run => run.status === "completed");
    const failures = success < 0 ? outcomes.length : success;
    const { installedPackage: _installedPackage, ...visible } = cloneRoutine(routine);
    const warning = routineHostWarning(routine), week = weekRuns(this.runs, routine.id, this.now());
    return { ...visible, ...(failures ? { failureStreak: failures } : {}), ...(week ? { weekRuns: week } : {}), ...(warning ? { warning } : {}) };
  }

  packageStamps(): Array<{ routineId: string; botId: string; enabled: boolean; stamp: RoutinePackageStamp }> {
    return this.routines.flatMap((routine) => routine.installedPackage
      ? [{ routineId: routine.id, botId: routine.botId, enabled: routine.enabled, stamp: structuredClone(routine.installedPackage) }]
      : []);
  }

  stampInstalledPackage(id: string, stamp: RoutinePackageStamp): boolean {
    const clean = loadInstalledPackage(stamp);
    if (!clean) throw new Error("Invalid routine package stamp");
    if (!this.routines.some((routine) => routine.id === id)) return false;
    this.commitMutation(() => {
      const routine = this.routines.find((candidate) => candidate.id === id)!;
      routine.installedPackage = clean;
    });
    return true;
  }

  wakeHold(horizonMs = WAKE_HORIZON_MS): { hold: boolean; reason?: "running" | "due"; at?: number } {
    const now = this.now();
    const startsLater = (run: RoutineRun) => run.status === "queued" && (run.retryAt ?? 0) > now;
    if (this.runs.some((run) => ["queued", "running", "waiting"].includes(run.status) && !startsLater(run))) return { hold: true, reason: "running" };
    const due = [...this.routines.filter((routine) => routine.enabled).map((routine) => routine.nextRunAt), ...this.runs.filter(startsLater).map((run) => run.retryAt)]
      .filter((at): at is number => at != null && at <= now + horizonMs)
      .sort((a, b) => a - b)[0];
    return due === undefined ? { hold: false } : { hold: true, reason: "due", at: due };
  }

  listRuns(from?: number, to?: number): RoutineRun[] {
    return this.runs
      .filter((r) => (from == null || r.scheduledFor >= from) && (to == null || r.scheduledFor <= to))
      .sort((a, b) => b.scheduledFor - a.scheduledFor)
      .map(cloneRun);
  }

  activeRunForBot(botId: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.botId === botId && ["running", "waiting"].includes(candidate.status),
    );
    return run ? cloneRun(run) : null;
  }

  activeBotRunForBot(botId: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.target === "bot" &&
        candidate.botId === botId &&
        ["running", "waiting"].includes(candidate.status),
    );
    return run ? cloneRun(run) : null;
  }

  routineRequestReceipt(requestId: string): RoutineRequestReceipt | null {
    const receipt = this.routineRequestReceipts.find((candidate) => candidate.requestId === requestId);
    return receipt ? { ...receipt } : null;
  }

  routineRequestReceiptOwners(): RoutineRequestOwner[] {
    return this.routineRequestReceipts.map(({ requestId, messageId, botId, threadId }) => ({
      requestId,
      messageId,
      botId,
      threadId,
    }));
  }

  /** Unsettled receipts are never count-evicted: an open card keeps its exactly-once recovery for its whole life. */
  forgetRoutineRequestReceipt(request: RoutineRequestCommit): boolean {
    const receipt = this.matchingRoutineRequestReceipt(request);
    if (!receipt) return false;
    const index = this.routineRequestReceipts.indexOf(receipt);
    this.commitMutation(() => {
      this.routineRequestReceipts.splice(index, 1);
    });
    return true;
  }

  forgetRoutineRequestReceiptsForThread(threadId: string): number {
    const kept = this.routineRequestReceipts.filter((receipt) => receipt.threadId !== threadId);
    const removed = this.routineRequestReceipts.length - kept.length;
    if (removed === 0) return 0;
    this.commitMutation(() => {
      this.routineRequestReceipts = kept;
    });
    return removed;
  }

  reconcileRoutineRequestReceipts(reachable: readonly RoutineRequestOwner[]): number {
    const keys = new Set(reachable.map(routineRequestOwnerKey));
    const kept = this.routineRequestReceipts.filter((receipt) => keys.has(routineRequestOwnerKey(receipt)));
    const removed = this.routineRequestReceipts.length - kept.length;
    if (removed === 0) return 0;
    this.commitMutation(() => {
      this.routineRequestReceipts = kept;
    });
    return removed;
  }

  isActiveThread(threadId: string): boolean {
    return this.runs.some(
      (run) => run.threadId === threadId && ["running", "waiting"].includes(run.status),
    );
  }

  runForThread(threadId: string): RoutineRun | null {
    const run = this.runs.find((candidate) => candidate.threadId === threadId);
    return run ? cloneRun(run) : null;
  }

  create(input: RoutineInput, request?: RoutineRequestCommitFor<"create">): Routine {
    this.assertWritable();
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.routines.find((routine) => routine.id === receipt.resultId);
        if (committed) return this.routineWithHealth(committed);
        throw new Error("This routine request was already applied");
      }
    }
    const at = this.now();
    const clean = sanitizeInput(input, at);
    if (this.targetState(clean) === "missing") throw new Error(this.missingTargetMessage(clean.target));
    const nextRunAt = clean.enabled ? this.initialOccurrence(clean.schedule, at) : null;
    if (clean.schedule.type === "interval" && clean.enabled && nextRunAt === null) {
      throw new Error("This interval has no future runs. Choose a later end date or turn it off.");
    }
    const routine: Routine = {
      id: randomUUID(),
      ...clean,
      // Only a confirmed chat card supplies `request`: the calendar API cannot pick an arbitrary transcript.
      sourceThreadId: request?.threadId,
      nextRunAt,
      createdAt: at,
      updatedAt: at,
    };
    const discardResults = this.applyResultsInput(routine, input.resultsThreadId);
    this.commitMutation(() => {
      this.routines.unshift(routine);
      if (request) this.rememberRoutineRequest(request, routine.id, at);
    }, discardResults);
    this.emitRoutine(routine);
    return this.routineWithHealth(routine);
  }

  update(
    id: string,
    patch: Partial<RoutineInput>,
    request?: RoutineRequestCommitFor<"update" | "pause" | "resume">,
  ): Routine | null {
    this.assertWritable();
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.routines.find((routine) => routine.id === receipt.resultId);
        return committed ? this.routineWithHealth(committed) : null;
      }
    }
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    const now = this.now();
    const clean = sanitizeInput({
      name: patch.name ?? routine.name,
      prompt: patch.prompt ?? routine.prompt,
      target: patch.target ?? routine.target,
      botId: patch.botId ?? routine.botId,
      groupId: Object.hasOwn(patch, "groupId") ? patch.groupId : routine.groupId,
      runOn: patch.runOn ?? routine.runOn,
      enabled: patch.enabled ?? routine.enabled,
      schedule: patch.schedule ? mergeScheduleUpdate(routine.schedule, patch.schedule) : routine.schedule,
      durationMinutes: patch.durationMinutes ?? routine.durationMinutes,
      timeoutMinutes: Object.hasOwn(patch, "timeoutMinutes") ? patch.timeoutMinutes : routine.timeoutMinutes,
      attachments: patch.attachments ?? routine.attachments,
      continuity: patch.continuity ?? routine.continuity,
      overlap: Object.hasOwn(patch, "overlap") ? patch.overlap : routine.overlap,
      runOnStartup: patch.runOnStartup ?? routine.runOnStartup,
    }, now);
    if (this.targetState(clean) === "missing") throw new Error(this.missingTargetMessage(clean.target));
    const scheduleChanged = JSON.stringify(clean.schedule) !== JSON.stringify(routine.schedule);
    const enabledChanged = clean.enabled !== routine.enabled;
    const nextRunAt = !clean.enabled ? null : scheduleChanged || enabledChanged
      ? this.initialOccurrence(clean.schedule, now)
      : routine.nextRunAt;
    if (clean.schedule.type === "interval" && clean.enabled && nextRunAt === null) {
      throw new Error("This interval has no future runs. Choose a later end date or turn it off.");
    }
    const destination = { ...routine, ...clean };
    if (destination.botId !== routine.botId) delete destination.resultsThreadId;
    const discardResults = this.applyResultsInput(destination, patch.resultsThreadId);
    const cancelledRuns: RoutineRun[] = [];
    this.commitMutation(() => {
      Object.assign(routine, clean, {
        resultsThreadId: destination.resultsThreadId,
        nextRunAt,
        // updatedAt doubles as the confirmation cards' optimistic revision: keep it monotonic within one ms.
        updatedAt: Math.max(now, routine.updatedAt + 1),
      });
      if (!clean.continuity) delete routine.continuity;
      if (clean.overlap !== "queue") delete routine.overlap;
      if (!clean.runOnStartup) delete routine.runOnStartup;
      if (Object.hasOwn(patch, "timeoutMinutes") && patch.timeoutMinutes == null) {
        delete routine.timeoutMinutes;
      }
      if (patch.enabled === false) {
        for (const run of this.runs) {
          if (run.routineId !== routine.id || run.status !== "queued") continue;
          run.status = "cancelled";
          run.attention = undefined;
          run.finishedAt = this.now();
          run.error = "The routine was paused before this run started";
          cancelledRuns.push(run);
        }
      }
      if (request) this.rememberRoutineRequest(request, routine.id, now);
    }, discardResults);
    for (const run of cancelledRuns) this.emitRun(run);
    this.emitRoutine(routine);
    return this.routineWithHealth(routine);
  }

  remove(id: string, request?: RoutineRequestCommitFor<"delete">): boolean {
    this.assertWritable();
    if (request && this.matchingRoutineRequestReceipt(request)) return true;
    const at = this.routines.findIndex((r) => r.id === id);
    if (at === -1) return false;
    const changedRuns: RoutineRun[] = [];
    this.commitMutation(() => {
      this.routines.splice(at, 1);
      for (const run of this.runs) {
        if (run.routineId !== id) continue;
        if (run.status === "queued") {
          run.status = "cancelled";
          run.attention = undefined;
          run.finishedAt = this.now();
          changedRuns.push(run);
        } else if (!run.seenAt && isRoutineProblemRun(run)) {
          run.seenAt = this.now();
          changedRuns.push(run);
        }
      }
      if (request) this.rememberRoutineRequest(request, id, this.now());
    });
    for (const run of changedRuns) this.emitRun(run);
    this.options.emit?.({ kind: "routine.deleted", routineId: id });
    return true;
  }

  disableForBot(botId: string) {
    let changed = false;
    for (const routine of this.routines) {
      if (routine.botId !== botId || !routine.enabled) continue;
      routine.enabled = false;
      routine.nextRunAt = null;
      routine.updatedAt = Math.max(this.now(), routine.updatedAt + 1);
      this.emitRoutine(routine);
      changed = true;
    }
    for (const run of this.runs) {
      if (run.botId !== botId || !["queued", "running", "waiting"].includes(run.status)) continue;
      run.status = "cancelled";
      if (run.target === "room-goal") run.goalStatus = "stopped";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = "The assigned bot was deleted";
      this.emitRun(run);
      if (run.threadId) {
        if (run.target === "room-goal" && run.groupId) {
          void this.options.interruptGoal?.(run.groupId, run.threadId).catch(() => {});
        } else {
          void this.options.interruptTurn?.(run.botId, run.threadId).catch(() => {});
        }
      }
      changed = true;
    }
    if (changed) this.save();
  }

  disableForGroup(groupId: string) {
    let changed = false;
    for (const routine of this.routines) {
      if (routine.target !== "room-goal" || routine.groupId !== groupId || !routine.enabled) continue;
      routine.enabled = false;
      routine.nextRunAt = null;
      routine.updatedAt = Math.max(this.now(), routine.updatedAt + 1);
      this.emitRoutine(routine);
      changed = true;
    }
    for (const run of this.runs) {
      if (
        run.target !== "room-goal" ||
        run.groupId !== groupId ||
        !["queued", "running", "waiting"].includes(run.status)
      ) continue;
      run.status = "cancelled";
      run.goalStatus = "stopped";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = "The assigned room was deleted";
      this.emitRun(run);
      if (run.threadId) {
        void this.options.interruptGoal?.(groupId, run.threadId).catch(() => {});
      }
      changed = true;
    }
    if (changed) this.save();
  }

  runNow(id: string, request?: RoutineRequestCommitFor<"run_now">): RoutineRun | null {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.runs.find((run) => run.id === receipt.resultId);
        return committed ? cloneRun(committed) : null;
      }
    }
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    let run!: RoutineRun;
    const allocations: ResultsThreadAllocation[] = [];
    const previousDestination = routine.resultsThreadId;
    this.commitMutation(() => {
      run = this.newRun(routine, this.now(), true, allocations, request?.threadId ?? routine.sourceThreadId);
      if (request) run.sourceThreadId = request.threadId;
      if (request) this.rememberRoutineRequest(request, run.id, this.now());
    }, () => this.discardResultsThreads(allocations));
    if (routine.resultsThreadId !== previousDestination) this.emitRoutine(routine);
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  webhookRunReceipt(webhookId: string, deliveryId: string): { id: string } | null {
    const receipt = this.webhookRunReceipts.find((candidate) =>
      candidate.webhookId === webhookId && candidate.deliveryId === deliveryId &&
      candidate.acceptedAt >= this.now() - EVENT_RETRY_WINDOW_MS);
    if (receipt) return { id: receipt.runId };
    const active = this.runs.find((run) => run.webhookId === webhookId && run.deliveryId === deliveryId &&
      ["queued", "running", "waiting"].includes(run.status));
    return active ? { id: active.id } : null;
  }

  enqueueWebhook(input: {
    webhookId: string;
    webhookName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
    eventSource?: "app";
  }): { id: string } {
    this.assertWritable();
    const existing = this.webhookRunReceipt(input.webhookId, input.deliveryId);
    if (existing) return existing;
    if (this.options.botState(input.botId) === "missing") {
      throw Object.assign(new Error("The assigned MAUS no longer exists"), { status: 410 });
    }
    const run: RoutineRun = {
      id: randomUUID(), routineId: input.webhookId, routineName: input.webhookName, prompt: input.prompt, target: "bot",
      botId: input.botId, runOn: input.runOn, scheduledFor: input.receivedAt, status: "queued", manual: false,
      triggerSource: "webhook", webhookId: input.webhookId, deliveryId: input.deliveryId, attachments: [], createdAt: this.now(),
      ...(input.eventSource ? { eventSource: input.eventSource } : {}),
    };
    this.commitEvent(run, input.deliveryId, () => { this.runs.push(run); });
    return cloneRun(run);
  }

  /** Adds an outside event to its trigger's run that has not started yet, so a burst becomes one run. Null when there
   *  is no such run or `merge` declines (the run is full). */
  mergeIntoQueuedRun(webhookId: string, deliveryId: string, merge: (prompt: string) => string | null): { id: string } | null {
    this.assertWritable();
    const existing = this.webhookRunReceipt(webhookId, deliveryId);
    if (existing) return existing;
    const run = this.runs.findLast((candidate) => candidate.webhookId === webhookId && candidate.status === "queued" && !candidate.threadId);
    const merged = run?.prompt === undefined ? null : merge(run.prompt);
    if (!run || merged === null) return null;
    const before = run.prompt;
    this.commitEvent(run, deliveryId, () => { run.prompt = merged; }, () => { run.prompt = before; });
    return { id: run.id };
  }

  private commitEvent(run: RoutineRun, deliveryId: string, apply: () => void, revert?: () => void): void {
    const previousReceipts = this.webhookRunReceipts;
    const receipts = previousReceipts.filter((receipt) => receipt.acceptedAt >= this.now() - EVENT_RETRY_WINDOW_MS);
    // Never evict a promised retry identity to admit fresh work.
    if (receipts.length >= MAX_EVENT_RECEIPTS) throw Object.assign(new Error("Webhook retry history is full; try again later"), { status: 429 });
    receipts.push({ webhookId: run.webhookId!, deliveryId, runId: run.id, acceptedAt: this.now() });
    const previousRuns = this.runs.slice();
    apply();
    this.webhookRunReceipts = receipts;
    try { this.save(); }
    catch (error) {
      // Keep the live run objects tick() may be awaiting, not cloned snapshots.
      this.runs = previousRuns;
      this.webhookRunReceipts = previousReceipts;
      revert?.();
      throw error;
    }
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
  }

  activeWebhookRunCount(webhookId: string): number {
    return this.runs.filter(
      (run) => run.webhookId === webhookId && ["queued", "running", "waiting"].includes(run.status),
    ).length;
  }

  cancelQueuedWebhook(webhookId: string, message: string): void {
    let changed = false;
    for (const run of this.runs) {
      if (run.webhookId !== webhookId || run.status !== "queued") continue;
      run.status = "cancelled";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = message.slice(0, 500);
      this.emitRun(run);
      changed = true;
    }
    if (changed) this.save();
  }

  async cancelRun(id: string, reason?: string): Promise<RoutineRun | null> {
    const run = this.runs.find((r) => r.id === id);
    if (!run || !["queued", "running", "waiting"].includes(run.status)) return null;
    run.status = "cancelled";
    if (run.target === "room-goal") run.goalStatus = "stopped";
    run.attention = undefined;
    run.finishedAt = this.now();
    if (reason) run.error = reason;
    this.save();
    this.emitRun(run);
    if (run.threadId) {
      if (run.target === "room-goal" && run.groupId) {
        await this.options.interruptGoal?.(run.groupId, run.threadId).catch(() => {});
      } else {
        await this.options.interruptTurn?.(run.botId, run.threadId).catch(() => {});
      }
    }
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  markSeen(id: string): RoutineRun | null {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return null;
    if (!run.seenAt) {
      run.seenAt = this.now();
      this.save();
      this.emitRun(run);
    }
    return cloneRun(run);
  }

  markAllSeen(): RoutineRun[] {
    if (!this.runs.some((run) => !run.seenAt && isRoutineProblemRun(run))) return [];
    const stampAt = this.now();
    const updated: RoutineRun[] = [];
    this.commitMutation(() => {
      for (const run of this.runs) {
        if (run.seenAt || !isRoutineProblemRun(run)) continue;
        run.seenAt = stampAt;
        updated.push(run);
      }
    });
    for (const run of updated) this.emitRun(run);
    return updated.map(cloneRun);
  }

  get isTicking(): boolean { return this.ticking; }

  start() {
    if (this.timer) return;
    if (!this.startupRunsQueued) this.startupRunsQueued = this.queueStartupRuns();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** At shutdown: a run whose turn the shutdown cuts stays running on disk, for the next start to pick up once. */
  close() {
    this.closing = true;
    this.stop();
  }

  private queueStartupRuns(): boolean {
    const launchId = this.options.launchId;
    if (launchId !== undefined && launchId === this.startupLaunchId) return true;
    const now = this.now();
    const flagged = this.routines.filter((routine) =>
      routine.enabled && routine.runOnStartup && routine.schedule.type !== "once" &&
      (routine.schedule.type !== "interval" || routine.schedule.endsAt === undefined || now <= routine.schedule.endsAt));
    const marked = flagged.filter((routine) =>
      !(routine.nextRunAt != null && routine.nextRunAt <= now && now - routine.nextRunAt <= CATCH_UP_MS) &&
      !this.runs.some((run) => run.routineId === routine.id && ["queued", "running", "waiting"].includes(run.status)));
    if (marked.length === 0 && launchId === undefined) return true;
    const previousLaunchId = this.startupLaunchId;
    const runs: RoutineRun[] = [];
    const allocations: ResultsThreadAllocation[] = [];
    try {
      this.commitMutation(() => {
        if (launchId !== undefined) this.startupLaunchId = launchId;
        for (const routine of marked) {
          const run = this.newRun(routine, now, false, allocations);
          run.triggerSource = "startup";
          runs.push(run);
          if (routine.nextRunAt != null && routine.nextRunAt <= now) this.advancePastOccurrence(routine, now, routine.nextRunAt);
        }
      }, () => {
        this.startupLaunchId = previousLaunchId;
        this.discardResultsThreads(allocations);
      });
    } catch (error) {
      console.error("routines: could not queue startup runs", error);
      return false;
    }
    for (const routine of marked) this.emitRoutine(routine);
    for (const run of runs) this.emitRun(run);
    return true;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const run of this.runs) {
        if (!["running", "waiting"].includes(run.status) || run.startedAt == null || run.timeoutMinutes == null ||
          activeMs(run, now) < run.timeoutMinutes * 60_000) continue;
        await this.stopRun(run, `Stopped after reaching the ${run.timeoutMinutes}-minute run limit`, "limit-reached");
      }
      const dueRoutines = this.routines.filter(
        (routine) => routine.enabled && routine.nextRunAt != null && routine.nextRunAt <= now,
      );
      // An unanswered wait gives way to its routine's next occurrence, which would otherwise be skipped behind it.
      for (const routine of dueRoutines) {
        if (routine.schedule.type === "once" || now - routine.nextRunAt! > CATCH_UP_MS) continue;
        const stale = this.runs.filter((run) => run.routineId === routine.id && supersededBy(routine.nextRunAt!, run, this.options.handedOffWorkLive));
        for (const run of stale) await this.cancelRun(run.id, ROUTINE_SUPERSEDED);
      }
      const scheduledRuns: RoutineRun[] = [];
      const allocations: ResultsThreadAllocation[] = [];
      if (dueRoutines.length > 0) {
        this.commitMutation(() => {
          for (const routine of dueRoutines) {
            const pendingAt = routine.nextRunAt!;
            const late = now - pendingAt;
            const scheduledFor = routine.schedule.type === "interval" && late <= CATCH_UP_MS
              ? latestIntervalOccurrence(routine.schedule, now) ?? pendingAt
              : pendingAt;
            const overlapping = routine.schedule.type !== "once" && this.runs.some(
              (run) => run.routineId === routine.id && ["queued", "running", "waiting"].includes(run.status),
            );
            const scheduledQueued = this.runs.some(run => run.routineId === routine.id && run.status === "queued" &&
              (run.triggerSource ?? (run.manual ? "manual" : "schedule")) === "schedule");
            if (!overlapping || (routine.overlap === "queue" && !scheduledQueued)) {
              const run = this.newRun(routine, scheduledFor, false, allocations);
              if (late > CATCH_UP_MS) {
                run.status = "missed";
                run.finishedAt = now;
                run.error = "This computer was offline for more than 12 hours after the scheduled time";
              }
              scheduledRuns.push(run);
            } else {
              const waiting = this.runs.find((run) => run.routineId === routine.id && run.status === "waiting" && run.waitingSince !== undefined);
              // Once per wait, an occurrence skipped behind it leaves a missed receipt, so the owner is told.
              if (waiting && skipNeedsNotice(scheduledFor, waiting.waitingSince!, routine.lastSkippedAt)) {
                const missed = this.newRun(routine, scheduledFor, false, allocations);
                missed.status = "missed";
                missed.finishedAt = now;
                missed.error = ROUTINE_SKIPPED_WHILE_WAITING;
                scheduledRuns.push(missed);
              }
              routine.skippedRuns = Math.min(Number.MAX_SAFE_INTEGER, (routine.skippedRuns ?? 0) + 1);
              routine.lastSkippedAt = scheduledFor;
            }
            this.advancePastOccurrence(routine, now, scheduledFor);
          }
        }, () => this.discardResultsThreads(allocations));
      }
      // Publish only after the scheduler batch is durable: reporting may persist transcript cards.
      for (const routine of dueRoutines) this.emitRoutine(routine);
      for (const run of scheduledRuns) this.emitRun(run);
      for (const run of scheduledRuns) {
        if (run.status === "missed") this.options.onRunFailed?.(cloneRun(run));
      }

      // Oldest first, by id: a rollback across awaits can replace the run objects.
      for (const id of this.runs.map((run) => run.id)) {
        const run = this.runs.find((candidate) => candidate.id === id);
        if (!run || run.status !== "queued" || (run.retryAt ?? 0) > now) continue;
        const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
        const definition = triggerSource === "schedule"
          ? this.routines.find((routine) => routine.id === run.routineId)
          : undefined;
        if (definition?.schedule.type === "interval") {
          const latest = latestIntervalOccurrence(definition.schedule, now);
          if (latest !== null && latest > run.scheduledFor) {
            run.scheduledFor = latest;
            this.save();
            this.emitRun(run);
          }
          const requiresCurrentDayOccurrence =
            definition.schedule.weekdays !== undefined || definition.schedule.window !== undefined;
          const mayDispatch = intervalAllowsOccurrence(definition.schedule, now) &&
            (!requiresCurrentDayOccurrence || (latest !== null && isSameLocalDay(latest, now)));
          if (!mayDispatch) {
            if (nextOccurrence(definition.schedule, now) === null) {
              this.failRun(run, "The routine ended before this scheduled run could start", "missed");
            }
            continue;
          }
        }
        const sameRoutineWorking = triggerSource === "schedule" && this.runs.some(other =>
          other.id !== run.id && other.routineId === run.routineId && ["running", "waiting"].includes(other.status));
        const state = sameRoutineWorking ? "busy" : this.targetState(run);
        if (state === "busy") {
          if (run.deferredAt == null) {
            run.deferredAt = now;
            this.save();
            this.emitRun(run);
          }
          if (run.deferredNoticeAt == null && now - run.deferredAt >= ROUTINE_DEFERRAL_NOTICE_MS) {
            run.deferredNoticeAt = now;
            this.save();
            this.emitRun(run);
            this.options.onRunDeferred?.(cloneRun(run));
          }
          continue;
        }
        if (state === "missing") {
          this.failRun(run, this.missingTargetMessage(run.target));
          continue;
        }
        const startedAt = this.now();
        const suffix = ` · ${new Date(startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
        const title = `${run.routineName.slice(0, 80 - suffix.length).trimEnd()}${suffix}`;
        const joined = run.target === "room-goal" ? null : run.threadId || this.options.joinConversation?.(run) || null;
        const task = joined
          ? { threadId: joined }
          : run.target === "room-goal"
          ? run.groupId
            ? this.options.createGoalTask?.(run.groupId, title) ?? null
            : null
          : this.options.createTask(run.botId, title, run.triggerSource === "webhook", run);
        if (!task) {
          this.failRun(run, run.target === "room-goal"
            ? "Could not create a room task for this goal"
            : "Could not create a task for this run");
          continue;
        }
        run.threadId = task.threadId;
        run.startedAt = startedAt;
        run.status = "running";
        this.save();
        this.emitRun(run);
        try {
          const prompt = run.prompt ?? this.routines.find((r) => r.id === run.routineId)?.prompt;
          if (!prompt) {
            this.failThread(task.threadId, "The routine was deleted before it could start");
            continue;
          }
          const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
          if (run.target === "room-goal") {
            if (!run.groupId || !this.options.startGoal) {
              this.failThread(task.threadId, "Room goal routines are unavailable");
              continue;
            }
            await this.options.startGoal(
              run.groupId,
              task.threadId,
              prompt,
              run.botId,
              run.id,
              (message) => this.failThread(task.threadId, message),
            );
          } else {
            await this.options.startTurn(
              run.botId,
              task.threadId,
              composeExecutionPrompt({ name: run.routineName, trigger: triggerSource, runOn: run.runOn ?? "maus" }, prompt, run.attachments, continuityCarry(run, this.routines, this.runs), run.retried),
              run.runOn ?? "maus",
              triggerSource,
              (message) => this.failThread(task.threadId, message),
            );
          }
        } catch (error) {
          this.failThread(task.threadId, error instanceof Error ? error.message : String(error), dispatchRefusal(error));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  handleRuntimeEvent(event: RuntimeEvent): RoutineRun | null {
    const run = this.runs.find((r) => r.threadId === event.threadId && ["running", "waiting"].includes(r.status));
    if (!run) return null;
    if (event.type === "turn.started" || event.type === "turn.completed") settleAsk(run, undefined, this.now());
    // A room goal's orchestrator owns its result (finishGoalRun); a member's completion is intermediate.
    if (
      run.target === "room-goal" &&
      (
        run.goalStatus === "needs-input" || run.goalStatus === "paused" ||
        event.type === "turn.completed" || (event.type === "item.completed" && event.itemType === "assistant_text")
      )
    ) return null;
    if (event.type === "turn.started") {
      run.status = "running";
      run.attention = undefined;
    } else if (event.type === "request.opened") {
      run.asked ??= askOf(event, this.now());
      this.wait(run, waitingFor(run.asked));
    } else if (event.type === "request.resolved") {
      const unanswered = settleAsk(run, event, this.now());
      if (unanswered) {
        void this.stopRun(run, unanswered, "stopped");
        return cloneRun(run);
      }
      run.status = "running";
      run.attention = undefined;
    } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
      run.output = redactSecretsInText(event.text).trim().slice(0, 2_000);
    } else if (event.type === "runtime.error") {
      run.error = redactSecretsInText(event.message).slice(0, 500);
      this.failureFacts.set(run.id, engineFacts(event));
    } else if (event.type === "turn.completed") {
      if (this.closing && (!event.ok || event.stopReason === "cancelled" || event.stopReason === "interrupted")) return null;
      if (event.cost != null) run.cost = (run.cost ?? 0) + event.cost;
      if (event.denials?.length) run.denials = [...new Set([...(run.denials ?? []), ...event.denials])];
      if (!event.ok) {
        this.settleFailure(run, routineFailure(run.error, event.stopReason), { ...this.failureFacts.get(run.id), stopReason: event.stopReason });
        return cloneRun(run);
      }
      this.failureFacts.delete(run.id);
      if (this.options.hasPendingDelegations?.(event.threadId) === true) this.wait(run, "Waiting for delegated work to finish");
      else {
        Object.assign(run, { status: "completed", attention: undefined, finishedAt: this.now() } satisfies Partial<RoutineRun>);
        this.ownerNotices = this.ownerNotices.filter((notice) => notice.botId !== run.botId);
      }
      run.error = undefined;
    } else {
      return null;
    }
    this.save();
    this.emitRun(run);
    if (event.type === "turn.completed") queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  failThread(threadId: string, message: string, facts: RoutineFailureFacts = {}) {
    const run = this.runs.find((r) => r.threadId === threadId && ["running", "waiting"].includes(r.status));
    if (run) this.settleFailure(run, message, facts);
  }

  private settleFailure(run: RoutineRun, failure: string, facts: RoutineFailureFacts) {
    this.failureFacts.delete(run.id);
    if (this.closing) return;
    const recovery = recoverRun(run, failure, facts, this.now(), this.ownerNotices);
    if (!recovery.queued) this.failRun(run, recovery.error, "failed", recovery.alert);
    else {
      this.save();
      this.emitRun(run);
      if (recovery.alert) this.options.onRunDeferred?.(cloneRun(run), recovery.alert);
    }
    queueMicrotask(() => void this.tick());
  }

  finishGoalRun(runId: string, status: GroupGoalRunStatus, detail: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.id === runId &&
        candidate.target === "room-goal" &&
        ["running", "waiting"].includes(candidate.status),
    );
    if (!run || status === "working") return null;
    const safeDetail = redactSecretsInText(detail).trim();
    run.goalStatus = status;
    if (status === "failed" || status === "blocked" || status === "limit-reached") {
      this.failRun(
        run,
        safeDetail ||
          (status === "limit-reached" ? "The room goal reached its turn limit" : "The room goal is blocked"),
      );
    } else if (status === "needs-input" || status === "paused") {
      this.wait(run, safeDetail.slice(0, 500) || (status === "paused" ? "The room goal is paused" : "The team needs your input"));
      run.error = undefined;
      this.save();
      this.emitRun(run);
    } else {
      run.status = status === "stopped" ? "cancelled" : "completed";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = undefined;
      if (status !== "stopped") run.output = safeDetail.slice(0, 2_000) || undefined;
      this.save();
      this.emitRun(run);
    }
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  /** Timed from when it began, so a later occurrence can tell a wait that went unanswered. */
  private wait(run: RoutineRun, attention: string | undefined) {
    if (run.status !== "waiting" || run.waitingSince === undefined) run.waitingSince = this.now();
    run.status = "waiting";
    run.attention = attention;
  }

  private async stopRun(run: RoutineRun, detail: string, status: "stopped" | "limit-reached") {
    if (run.target === "room-goal") run.goalStatus = status;
    this.failRun(run, detail);
    if (!run.threadId) return;
    if (run.target === "room-goal" && run.groupId) await this.options.interruptGoal?.(run.groupId, run.threadId, { status, detail }).catch(() => {});
    else await this.options.interruptTurn?.(run.botId, run.threadId).catch(() => {});
  }

  private failRun(run: RoutineRun, message: string, status: "failed" | "missed" = "failed", alert?: RoutineAlert | null) {
    run.status = status;
    run.attention = undefined;
    run.error = redactSecretsInText(message).slice(0, 500);
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
    this.options.onRunFailed?.(cloneRun(run), alert);
  }

  private advancePastOccurrence(routine: Routine, now: number, occurrence: number) {
    routine.nextRunAt =
      routine.schedule.type === "once" ? null : nextOccurrence(routine.schedule, Math.max(now, occurrence));
    // Not a definition edit: bumping updatedAt here would stale a pending confirmation card.
    if (routine.schedule.type === "once") {
      routine.enabled = false;
      routine.updatedAt = Math.max(now, routine.updatedAt + 1);
    } else if (routine.schedule.type === "interval" && routine.nextRunAt === null) {
      routine.enabled = false;
      routine.updatedAt = Math.max(now, routine.updatedAt + 1);
    }
  }

  private targetState(target: Pick<RoutineRun, "target" | "groupId" | "botId">): "ready" | "busy" | "missing" {
    if (target.target === "room-goal") {
      if (!target.groupId || !this.options.goalState) return "missing";
      return this.options.goalState(target.groupId, target.botId);
    }
    return this.options.botState(target.botId);
  }

  private missingTargetMessage(target: RoutineTarget): string {
    return target === "room-goal"
      ? "The assigned room or coordinator no longer exists"
      : "The assigned bot no longer exists";
  }

  private initialOccurrence(schedule: RoutineSchedule, now: number): number | null {
    // The original time, not max(at, now): tick() decides fire vs missed from it.
    if (schedule.type === "once") return schedule.at;
    return nextOccurrence(schedule, now);
  }

  private newRun(
    routine: Routine,
    scheduledFor: number,
    manual: boolean,
    allocations: ResultsThreadAllocation[],
    sourceThreadId = routine.sourceThreadId,
  ): RoutineRun {
    let resultsThreadId = routine.resultsThreadId;
    if (routine.target === "bot" && this.options.resolveResultsThread) {
      const destination = this.options.resolveResultsThread({ ...routine, sourceThreadId }, false);
      const own = destination?.main ? undefined : destination?.threadId;
      if (own !== routine.resultsThreadId) {
        if (own) allocations.push({ botId: routine.botId, threadId: own });
        if (own) routine.resultsThreadId = own;
        else delete routine.resultsThreadId;
        routine.updatedAt = Math.max(this.now(), routine.updatedAt + 1);
      }
      resultsThreadId = destination?.threadId;
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
      resultsThreadId,
      createdAt: this.now(),
    };
    this.runs.push(run);
    return run;
  }

  private discardResultsThreads(allocations: ResultsThreadAllocation[]) {
    for (const { botId, threadId } of allocations) {
      try {
        this.options.discardResultsThread?.(botId, threadId);
      } catch (error) {
        console.error("routine: could not discard uncommitted results thread", error);
      }
    }
  }

  private applyResultsInput(routine: Routine, value: RoutineInput["resultsThreadId"]) {
    if (routine.target !== "bot") {
      if (value != null) throw Object.assign(new Error("Results threads are only available for bot routines"), { status: 400 });
      delete routine.resultsThreadId;
      return;
    }
    if (value === undefined) return;
    if (value === null) {
      const destination = this.options.resolveResultsThread?.(routine, true);
      if (!destination || destination.main) {
        delete routine.resultsThreadId;
        return;
      }
      routine.resultsThreadId = destination.threadId;
      return () => this.options.discardResultsThread?.(routine.botId, destination.threadId);
    }
    if (typeof value !== "string" || !value.trim() || !this.options.isResultsThread?.(routine.botId, value.trim())) {
      throw Object.assign(new Error("Choose a visible results thread belonging to this bot"), { status: 400 });
    }
    routine.resultsThreadId = value.trim();
  }

  private emitRoutine(routine: Routine) {
    this.options.emit?.({ kind: "routine", routine: this.routineWithHealth(routine) });
  }

  private emitRun(run: RoutineRun) {
    this.options.emit?.({ kind: "routine.run", run: cloneRun(run) });
    this.notifyRunChanged(run);
    if (run.status === "completed" || run.status === "failed") {
      const routine = this.routines.find(candidate => candidate.id === run.routineId);
      if (routine) this.emitRoutine(routine);
    }
  }

  private notifyRunChanged(run: RoutineRun) {
    try {
      this.options.onRunChanged?.(cloneRun(run));
    } catch (error) {
      console.error("routine: source-thread lifecycle update failed", error);
    }
  }

  private matchingRoutineRequestReceipt(request: RoutineRequestCommit): RoutineRequestReceipt | null {
    const receipt = this.routineRequestReceipts.find((candidate) => candidate.requestId === request.requestId);
    if (!receipt) return null;
    if (
      receipt.action !== request.action ||
      receipt.messageId !== request.messageId ||
      receipt.botId !== request.botId ||
      receipt.threadId !== request.threadId ||
      receipt.fingerprintVersion !== request.fingerprintVersion ||
      receipt.fingerprint !== request.fingerprint
    ) {
      throw new Error("Routine request receipt does not match this confirmation card");
    }
    return receipt;
  }

  private rememberRoutineRequest(
    request: RoutineRequestCommit,
    resultId: string,
    appliedAt: number,
  ) {
    const existing = this.matchingRoutineRequestReceipt(request);
    if (existing) {
      if (existing.resultId !== resultId) throw new Error("Routine request receipt has another result");
      return;
    }
    this.routineRequestReceipts.unshift({ ...request, resultId, appliedAt });
  }

  private assertWritable(): void {
    if (this.unreadable) throw Object.assign(new Error("Saved routines could not be read. Repair routines.json before changing them."), { status: 503 });
  }

  /** Rolls memory back when the write fails, so a retry never mistakes an uncommitted action for a durable one. */
  private commitMutation(mutate: () => void, rollback?: () => void): void {
    const before = {
      routines: this.routines.map(cloneRoutine),
      runs: this.runs.map(cloneRun),
      receipts: this.routineRequestReceipts.map((receipt) => ({ ...receipt })),
    };
    try {
      mutate();
      this.save();
    } catch (error) {
      this.routines = before.routines;
      this.runs = before.runs;
      this.routineRequestReceipts = before.receipts;
      try {
        rollback?.();
      } catch (cleanupError) {
        console.error("routine: could not discard uncommitted results thread", cleanupError);
      }
      throw error;
    }
  }

  private save() {
    if (this.unreadable) return;
    // Evict only terminal receipts: an active one owns cancellation, timeout and event routing.
    let excess = this.runs.length - MAX_RUNS;
    for (let index = 0; index < this.runs.length && excess > 0;) {
      if (["queued", "running", "waiting"].includes(this.runs[index]!.status)) {
        index += 1;
        continue;
      }
      this.runs.splice(index, 1);
      excess -= 1;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({
      version: 1,
      ...(this.frozenPending ? {} : { frozenResultsCleared: true }),
      routines: [...this.routines, ...this.unloadedRoutines],
      runs: this.runs,
      routineRequestReceipts: this.routineRequestReceipts,
      webhookRunReceipts: this.webhookRunReceipts,
      ...(this.startupLaunchId === undefined ? {} : { startupLaunchId: this.startupLaunchId }),
      ...(this.ownerNotices.length ? { ownerNotices: this.ownerNotices } : {}),
    } satisfies RoutineFile, null, 2), { mode: 0o600 });
  }
}
