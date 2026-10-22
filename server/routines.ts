import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { writeFileAtomic } from "./atomic.ts";
import { redactSecretsInText } from "./redact.ts";
import { activeRunsOf, nextDueOf, wakeHoldOf } from "./routine-due.ts";
import type { GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import type { RoutineRequestOperation } from "../shared/routine-request.ts";
import { intervalAllowsOccurrence, intervalHasRestrictions, isSameLocalDay, latestIntervalOccurrence } from "./routine-intervals.ts";
import { cloneSchedule, limitResetOccurrence, mergeScheduleUpdate, nextOccurrence, RoutineScheduleError, type RoutineSchedule, type RoutineScheduleInput } from "./routine-schedules.ts";
import { runsOnce } from "../shared/limit-reset.ts";
import {
  isRoutineProblemRun, type RoutineAccess, type RoutineCheck, type RoutineContextAttachment, type RoutineDelivery, type RoutineIntervalWindow, type RoutineRetryCause,
  type RoutineRunReport, type RoutineRunStatus, type RoutineRunTrigger,
} from "../shared/routines.ts";
import type { PartPair, RoutinePart } from "./package-parts.ts";
import {
  composeExecutionPrompt, continuityCarry, ROUTINE_DEFERRAL_NOTICE_MS, ROUTINE_SKIPPED_WHILE_WAITING, ROUTINE_SUPERSEDED,
  routineFailure, routineHostWarning, skipNeedsNotice, supersededBy,
} from "./routine-execution.ts";
import {
  dispatchRefusal, engineFacts, loadOwnerNotices, recoverRun, requeueOnce, weekRuns, type RoutineAlert, type RoutineFailureFacts, type RoutineOwnerNotice,
} from "./routine-recovery.ts";
import { activeMs, askOf, settleAsk, waitingFor, type RoutineRunAsk } from "./routine-waits.ts";
import { failsLikeLastOutcome, outcomesNewestFirst } from "./routine-outcomes.ts";
import { EVENT_RETRY_WINDOW_MS, loadEventReceipts, MAX_EVENT_RECEIPTS, type EventRunReceipt } from "./routine-event-receipts.ts";
import { cloneAttachments } from "./routine-attachments.ts";
import { loadInstalledPackage, loadRoutine, loadRun } from "./routine-load.ts";
import { sanitizeInput } from "./routine-input.ts";
import { checkHold, CHECK_BOOT_HOLD_MS, type CheckHold } from "./routine-check-pacing.ts";

export type { RoutineContextAttachment, RoutineIntervalWindow, RoutineRunStatus, RoutineRunTrigger };
export { intervalHasRestrictions } from "./routine-intervals.ts";
export { nextOccurrence, RoutineScheduleError } from "./routine-schedules.ts";
export type { RoutineIntervalSchedule, RoutineIntervalScheduleInput, RoutineSchedule, RoutineScheduleInput } from "./routine-schedules.ts";

/** `cloud` runs the agent inside the bot's Boat VM; `maus` runs the bot's own provider and borrows only its computer tools. */
export type RoutineRunOn = "maus" | "cloud";
export type RoutineTarget = "bot" | "room-goal";
export type RoutineGoalStatus = Exclude<GroupGoalRunStatus, "working">;


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
  report?: RoutineRunReport;
  access?: RoutineAccess;
  deliver?: RoutineDelivery;
  checkKey?: string;
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
  checks?: RoutineCheck[] | null;
  access?: RoutineAccess | null;
  deliver?: RoutineDelivery | null;
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

/** What a routine's checks found: items for one AI run, a sentence while an app cannot be read, and the next time they
 * have something to do on time. */
export interface RoutineCheckResult { run?: { prompt: string; key: string }; trouble?: string; wakeAt?: number }

export interface RoutineChecks {
  /** Runs a routine's checks. With `hold` they may do only what needs no AI, and their items wait. */
  check(routine: Routine, context: { manual: boolean; hold?: CheckHold }): Promise<RoutineCheckResult>;
  /** Items handed to a run that was never queued. */
  release(key: string): void;
  /** A run holding checked items ended. Called again on later changes to that run. */
  settled(run: RoutineRun): void;
}

export interface RoutineManagerOptions {
  file?: string;
  now?: () => number;
  /** Every payload must be `{ kind, … }`: the server numbers and replays frames by it. */
  emit?: (payload: Record<string, unknown>) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  goalState?: (groupId: string, coordinatorBotId: string) => "ready" | "busy" | "missing";
  createTask: (botId: string, title: string, run?: RoutineRun) => { threadId: string } | null;
  joinConversation?: (run: RoutineRun) => string | null;
  createGoalTask?: (groupId: string, title: string) => { threadId: string } | null;
  isResultsThread?: (botId: string, threadId: string) => boolean;
  resolveResultsThread?: (routine: Routine, forceNew: boolean) => { threadId: string; main?: true } | undefined;
  eventResultsThread?: (event: { webhookId: string; webhookName: string; botId: string }) => string | undefined;
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
  /** The turn in this thread is a routine's own, not one a person started there while its run waits on teammates. */
  routineTurn?: (threadId: string) => boolean;
  /** When an engine's usage limit resets (epoch ms), or null while that is not known. */
  limitResetAt?: (engine: string) => number | null;
  /** The bot has a backup engine to continue on when its own engine's usage limit refuses a run. */
  limitBackup?: (botId: string) => boolean;
  /** Work this thread handed to another bot is still open, so its wait is not only on the person. */
  handedOffWorkLive?: (threadId: string) => boolean;
  launchId?: string;
  /** A Cloud home woken from a sleep it was stopped for (server/cloud-power.ts): not a startup, so no "run on startup". */
  skipStartupRuns?: boolean;
  checks?: RoutineChecks;
}

const CATCH_UP_MS = 12 * 60 * 60_000;
const WAKE_HORIZON_MS = 60 * 60_000;

export const ROUTINE_RESTARTED = "OpenMausBot restarted while this routine was running";
const MAX_RUNS = 2_000;
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
  private readonly bootedAt: number;
  private readonly checking = new Set<string>();

  constructor(options: RoutineManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "routines.json");
    this.now = options.now ?? Date.now;
    this.bootedAt = this.now();
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RoutineFile>;
      if (disk === null || typeof disk !== "object" || Array.isArray(disk)) throw new Error("Invalid routines file");
      for (const key of ["routines", "runs", "routineRequestReceipts", "webhookRunReceipts"] as const) {
        if (key in disk && !Array.isArray(disk[key])) throw new Error(`Invalid routines file: ${key} is not a list`);
      }
      this.routines = Array.isArray(disk.routines) ? disk.routines.flatMap((routine) => {
        const loaded = loadRoutine(routine, this.now());
        if (!loaded) {
          console.warn(`routines: keeping ${String(routine.id)} on disk unscheduled; its schedule could not load`);
          this.unloadedRoutines.push(routine);
        }
        return loaded ? [loaded] : [];
      }) : [];
      this.runs = Array.isArray(disk.runs) ? disk.runs.map(loadRun) : [];
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
    const outcomes = outcomesNewestFirst(this.runs, routine.id);
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

  wakeHold(horizonMs = WAKE_HORIZON_MS) { return wakeHoldOf(this.routines, this.runs, this.now(), horizonMs); }
  /** A Cloud home's sleep check (server/routine-due.ts). */
  hasActiveRuns(): boolean { return activeRunsOf(this.runs, this.now()); }
  nextDueAt(): number | null { return nextDueOf(this.routines, this.runs, this.now()); }

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
    const run = this.runs.findLast((candidate) => candidate.threadId === threadId && ["running", "waiting"].includes(candidate.status)) ??
      this.runs.findLast((candidate) => candidate.threadId === threadId);
    return run ? cloneRun(run) : null;
  }

  noteReport(id: string, report: RoutineRunReport | undefined): RoutineRun | null {
    const run = this.runs.find((candidate) => candidate.id === id);
    if (!run) return null;
    if (report) run.report = report;
    else delete run.report;
    this.save();
    this.emitRun(run);
    return cloneRun(run);
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
    clean.schedule = this.timedSchedule(clean.schedule);
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

  /** Routines and runs another server holds, under their own ids: `apply` edits the lists, which are saved whole or not at all. */
  adopt(apply: (held: { routines: Routine[]; runs: RoutineRun[] }) => Routine[]): void { this.assertWritable(); let changed: Routine[] = []; this.commitMutation(() => { changed = apply({ routines: this.routines, runs: this.runs }); }); for (const routine of changed) this.emitRoutine(routine); }

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
      checks: Object.hasOwn(patch, "checks") ? patch.checks : routine.checks,
      access: Object.hasOwn(patch, "access") ? patch.access : routine.access,
      deliver: Object.hasOwn(patch, "deliver") ? patch.deliver : routine.deliver,
    }, now);
    clean.schedule = this.timedSchedule(clean.schedule, routine.id);
    if (this.targetState(clean) === "missing") throw new Error(this.missingTargetMessage(clean.target));
    const scheduleChanged = JSON.stringify(clean.schedule) !== JSON.stringify(routine.schedule);
    const enabledChanged = clean.enabled !== routine.enabled;
    if (enabledChanged && clean.enabled && clean.schedule.type === "once" && clean.schedule.at <= now) throw new RoutineScheduleError("Its time has passed. Edit it to pick a new time.");
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
      if (!clean.access) delete routine.access;
      if (!clean.deliver) delete routine.deliver;
      if (!clean.checks) for (const key of ["checks", "checkedAt", "checkTrouble", "wakeAt"] as const) delete routine[key];
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

  /** A deleted bot's schedules go with it: each is removed, its unfinished runs stop, and its run history is dropped. */
  removeForBot(botId: string) {
    for (const routine of this.routines.filter((candidate) => candidate.botId === botId)) this.remove(routine.id);
    for (const run of this.runs) {
      if (run.botId !== botId || !["queued", "running", "waiting"].includes(run.status)) continue;
      run.status = "cancelled";
      if (run.target === "room-goal") run.goalStatus = "stopped";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = "The assigned bot was deleted";
      this.emitRun(run);
      if (run.threadId && run.target === "room-goal" && run.groupId) void this.options.interruptGoal?.(run.groupId, run.threadId).catch(() => {});
      else if (run.threadId) void this.options.interruptTurn?.(run.botId, run.threadId).catch(() => {});
    }
    const kept = this.runs.filter((run) => run.botId !== botId);
    if (kept.length !== this.runs.length) this.commitMutation(() => { this.runs = kept; });
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
      resultsThreadId: this.options.eventResultsThread?.(input), ...(input.eventSource ? { eventSource: input.eventSource } : {}),
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

  markAllSeen(visible: (run: RoutineRun) => boolean = () => true): RoutineRun[] {
    const due = (run: RoutineRun) => !run.seenAt && isRoutineProblemRun(run) && visible(run);
    if (!this.runs.some(due)) return [];
    const stampAt = this.now();
    const updated: RoutineRun[] = [];
    this.commitMutation(() => {
      for (const run of this.runs.filter(due)) {
        run.seenAt = stampAt;
        updated.push(run);
      }
    });
    for (const run of updated) this.emitRun(run);
    return updated.map(cloneRun);
  }

  /** The computer's clock moved to another time zone (a Cloud took its owner's): a daily or weekly time, or an interval
   * kept to some days or hours, now falls at another instant. A cron rule names its own zone, a one-time run is an
   * instant and a plain interval counts elapsed time, so those keep theirs. Returns how many moved. */
  rescheduleLocalTimes(): number {
    const now = this.now();
    const moved = this.routines.filter((routine) => {
      const local = routine.schedule.type === "daily" || (routine.schedule.type === "interval" && intervalHasRestrictions(routine.schedule));
      if (!routine.enabled || routine.nextRunAt == null || !local) return false;
      const next = nextOccurrence(routine.schedule, now);
      if (next === routine.nextRunAt) return false;
      routine.nextRunAt = next;
      return true;
    });
    if (moved.length) this.save();
    for (const routine of moved) this.emitRoutine(routine);
    return moved.length;
  }

  /** The engines' reset times changed: each limit-reset routine that is on takes its engine's new time. */
  retimeLimitResets(): number {
    const moved = this.routines.filter((routine) => {
      if (!routine.enabled || routine.schedule.type !== "limit_reset") return false;
      const schedule = this.timedSchedule(routine.schedule, routine.id);
      if (schedule.type !== "limit_reset" || (schedule.at === routine.schedule.at && schedule.at === routine.nextRunAt)) return false;
      routine.schedule = schedule;
      routine.nextRunAt = schedule.at;
      return true;
    });
    if (moved.length) this.save();
    for (const routine of moved) this.emitRoutine(routine);
    return moved.length;
  }

  /** Moves only the next run to `until`; the runs after it keep their schedule. A limit-reset routine has no time to move. */
  deferNextRun(id: string, until: number): Routine | null {
    const routine = this.routines.find((candidate) => candidate.id === id);
    if (!routine) return null;
    if (!routine.enabled || routine.nextRunAt === null || routine.nextRunAt >= until || routine.schedule.type === "limit_reset") return this.routineWithHealth(routine);
    this.commitMutation(() => {
      if (routine.schedule.type === "once") routine.schedule = { type: "once", at: until };
      routine.nextRunAt = until;
    });
    this.emitRoutine(routine);
    return this.routineWithHealth(routine);
  }

  private timedSchedule(schedule: RoutineSchedule, routineId?: string, ranFor?: number): RoutineSchedule {
    if (schedule.type !== "limit_reset") return schedule;
    const last = ranFor ?? (routineId ? this.runs.findLast((run) => run.routineId === routineId && run.triggerSource === "schedule")?.scheduledFor : undefined);
    return { ...schedule, at: limitResetOccurrence(this.options.limitResetAt?.(schedule.engine) ?? null, last) };
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
    if (this.options.skipStartupRuns) return true;
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
      const dueRoutines = this.routines.filter((routine) => routine.enabled && this.targetState(routine) !== "missing" && (!routine.checks
        ? routine.nextRunAt != null && routine.nextRunAt <= now
        : now >= this.bootedAt + CHECK_BOOT_HOLD_MS && [routine.nextRunAt, routine.wakeAt].some((at) => at != null && at <= now)));
      // An unanswered wait gives way to its routine's next occurrence, which would otherwise be skipped behind it.
      for (const routine of dueRoutines) {
        if (routine.checks || runsOnce(routine.schedule) || now - routine.nextRunAt! > CATCH_UP_MS) continue;
        const stale = this.runs.filter((run) => run.routineId === routine.id && supersededBy(routine.nextRunAt!, run, this.options.handedOffWorkLive));
        for (const run of stale) await this.cancelRun(run.id, ROUTINE_SUPERSEDED);
      }
      const scheduledRuns: RoutineRun[] = [];
      const allocations: ResultsThreadAllocation[] = [];
      const checks: Array<{ id: string; hold?: CheckHold }> = [];
      if (dueRoutines.length > 0) {
        this.commitMutation(() => {
          for (const routine of dueRoutines) {
            // A routine with checks never misses: however late, one check reads everything since the last.
            if (routine.checks) {
              if (!this.checking.has(routine.id)) checks.push({ id: routine.id, hold: checkHold(this.runs, routine.id, now) });
              if (routine.nextRunAt != null && routine.nextRunAt <= now) this.advancePastOccurrence(routine, now, routine.nextRunAt);
              delete routine.wakeAt;
              continue;
            }
            const pendingAt = routine.nextRunAt!;
            const late = now - pendingAt;
            const scheduledFor = routine.schedule.type === "interval" && late <= CATCH_UP_MS
              ? latestIntervalOccurrence(routine.schedule, now) ?? pendingAt
              : pendingAt;
            const overlapping = !runsOnce(routine.schedule) && this.runs.some(
              (run) => run.routineId === routine.id && ["queued", "running", "waiting"].includes(run.status),
            );
            const scheduledQueued = this.runs.some(run => run.routineId === routine.id && run.status === "queued" &&
              (run.triggerSource ?? (run.manual ? "manual" : "schedule")) === "schedule");
            if (!overlapping || (routine.overlap === "queue" && !scheduledQueued)) {
              const run = this.newRun(routine, scheduledFor, false, allocations);
              // A reset is a state, not a moment: it still holds however late the computer wakes.
              if (late > CATCH_UP_MS && routine.schedule.type !== "limit_reset") {
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
      for (const { id, hold } of checks) void this.runChecks(id, hold);

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
        const checked = triggerSource === "webhook" || run.checkKey ? undefined : this.routines.find((routine) => routine.id === run.routineId && routine.checks);
        if (checked) {
          void this.runChecks(checked.id, checkHold(this.runs, checked.id, now, run.id), run.id);
          continue;
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
          if (run.deferredNoticeAt == null && !run.checkKey && now - run.deferredAt >= ROUTINE_DEFERRAL_NOTICE_MS) {
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
          : this.options.createTask(run.botId, title, run);
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

  /** Runs a routine's checks: what needs the AI becomes one run, or fills `manual`, the queued run the person started.
   * Nothing new leaves no run behind a scheduled check, and a quiet completed one behind a manual check. */
  private async runChecks(routineId: string, hold: CheckHold | undefined, manual?: string): Promise<void> {
    const hook = this.options.checks, key = manual ?? routineId, routine = this.routines.find((candidate) => candidate.id === routineId);
    if (!hook || !routine || this.checking.has(key)) return;
    this.checking.add(key);
    let result: RoutineCheckResult;
    try {
      result = await hook.check(cloneRoutine(routine), { manual: manual !== undefined, ...(hold ? { hold } : {}) });
    } catch (error) {
      console.error(`routines: the checks of ${routineId} failed`, error);
      result = { trouble: "The checks could not run; they try again at the next check." };
    } finally {
      this.checking.delete(key);
    }
    const current = this.routines.find((candidate) => candidate.id === routineId);
    const queued = manual === undefined ? undefined : this.runs.find((run) => run.id === manual && run.status === "queued");
    if (!current?.checks || (manual === undefined ? !current.enabled : !queued)) {
      if (result.run) hook.release(result.run.key);
      return;
    }
    const allocations: ResultsThreadAllocation[] = [];
    let run: RoutineRun | undefined;
    try {
      this.commitMutation(() => {
        for (const field of ["wakeAt", "checkTrouble"] as const) delete current[field];
        Object.assign(current, result.wakeAt === undefined ? {} : { wakeAt: result.wakeAt }, result.trouble ? { checkTrouble: result.trouble.slice(0, 300) } : {},
          result.trouble || result.run ? {} : { checkedAt: this.now() });
        if (result.run) {
          run = queued ?? this.newRun(current, this.now(), false, allocations);
          Object.assign(run, { prompt: result.run.prompt, checkKey: result.run.key });
        } else if (queued && !result.trouble) {
          Object.assign(queued, { status: "completed", output: "Nothing new since the last check", report: { state: "quiet" }, finishedAt: this.now() } satisfies Partial<RoutineRun>);
        }
      }, () => this.discardResultsThreads(allocations));
    } catch (error) {
      if (result.run) hook.release(result.run.key);
      throw error;
    }
    this.emitRoutine(current);
    if (queued && !result.run && result.trouble) this.failRun(queued, result.trouble);
    else if (run ?? queued) this.emitRun((run ?? queued)!);
    if (run) queueMicrotask(() => void this.tick());
  }

  handleRuntimeEvent(event: RuntimeEvent): RoutineRun | null {
    const run = this.runs.find((r) => r.threadId === event.threadId && ["running", "waiting"].includes(r.status));
    if (!run || (run.target === "bot" && run.status === "waiting" && !run.asked && this.options.routineTurn?.(event.threadId) === false)) return null;
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

  /** A completed run whose answer its consumer could not use: it fails like any run, so its items go back. */
  rejectResult(id: string, why: string): void {
    const run = this.runs.find((candidate) => candidate.id === id && candidate.status === "completed");
    if (run) this.failRun(run, why);
  }

  failThread(threadId: string, message: string, facts: RoutineFailureFacts = {}) {
    const run = this.runs.find((r) => r.threadId === threadId && ["running", "waiting"].includes(r.status));
    if (run) this.settleFailure(run, message, facts);
  }

  private settleFailure(run: RoutineRun, failure: string, facts: RoutineFailureFacts) {
    this.failureFacts.delete(run.id);
    if (this.closing) return;
    const backupReady = facts.limitResetsAt !== undefined && this.options.limitBackup?.(run.botId) === true;
    const recovery = recoverRun(run, failure, { ...facts, ...(backupReady ? { backupReady } : {}) }, this.now(), this.ownerNotices);
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
    const repeat = failsLikeLastOutcome(this.runs, run) || (run.checkKey !== undefined && outcomesNewestFirst(this.runs, run.routineId, run.id)[0]?.status === "failed");
    this.options.onRunFailed?.(cloneRun(run), alert === undefined && repeat ? null : alert);
  }

  private advancePastOccurrence(routine: Routine, now: number, occurrence: number) {
    if (routine.schedule.type === "limit_reset" && routine.schedule.repeat === "every_reset") routine.schedule = this.timedSchedule(routine.schedule, routine.id, occurrence);
    routine.nextRunAt =
      runsOnce(routine.schedule) ? null : nextOccurrence(routine.schedule, Math.max(now, occurrence));
    // Not a definition edit: bumping updatedAt here would stale a pending confirmation card.
    if (runsOnce(routine.schedule)) {
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
    if (schedule.type === "once" || schedule.type === "limit_reset") return schedule.at;
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
      ...(routine.access ? { access: routine.access } : {}),
      ...(routine.deliver ? { deliver: routine.deliver } : {}),
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
    if (run.checkKey && !["queued", "running", "waiting"].includes(run.status)) this.options.checks?.settled(cloneRun(run));
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
      try { rollback?.(); }
      catch (cleanupError) { console.error("routine: could not discard uncommitted results thread", cleanupError); }
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
