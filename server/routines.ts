import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { OwnedFile } from "./atomic.ts"; import { beginSaves, endSaves, saveSoon } from "./save-batch.ts"; import { RunProgressSave } from "./routine-progress-save.ts";
import { redactSecretsInText } from "./redact.ts";
import { activeRunsOf, nextDueOf, schedulerDueOf, wakeHoldOf } from "./routine-due.ts";
import { startDueTimer, type DueTimer } from "./due-timer.ts";
import type { GroupGoalRunStatus } from "../shared/group-goal-run.ts";
import type { RoutineRequestOperation } from "../shared/routine-request.ts";
import type { ModelSelection } from "../shared/wire.ts";
import { intervalAllowsOccurrence, intervalHasRestrictions, isSameLocalDay, latestIntervalOccurrence } from "./routine-intervals.ts";
import { cloneSchedule, limitResetOccurrence, mergeScheduleUpdate, nextOccurrence, RoutineScheduleError, type RoutineSchedule, type RoutineScheduleInput } from "./routine-schedules.ts";
import { runsOnce } from "../shared/limit-reset.ts"; import { limitResetRunOwed } from "./limit-reset-owed.ts";
import {
  ROUTINE_HANDOFF_WAIT, isRoutineProblemRun, type RoutineAccess, type RoutineCheck, type RoutineContextAttachment, type RoutineDelivery, type RoutineIntervalWindow, type RoutineRetryCause,
  type RoutineHoldCause, type RoutineRunReport, type RoutineRunStatus, type RoutineRunTrigger,
} from "../shared/routines.ts";
import type { PartPair, RoutinePart } from "./package-parts.ts";
import {
  composeExecutionPrompt, continuityCarry, ROUTINE_DEFERRAL_NOTICE_MS, ROUTINE_SUPERSEDED,
  routineFailure, routineHostWarning, supersededBy,
} from "./routine-execution.ts";
import {
  dispatchRefusal, engineFacts, nextScheduledRun, recoverRun, requeueOnce, startPrompt, weekRuns, type RefusedRunLine, type RoutineAlert, type RoutineFailureFacts, type RoutineOwnerMark, type RoutineOwnerNotice,
} from "./routine-recovery.ts";
import { askOf, settleAsk, waitingFor, type RoutineRunAsk } from "./routine-waits.ts";
import { failsLikeLastOutcome, outcomesNewestFirst } from "./routine-outcomes.ts"; import { createRunGate, type RunPreparation } from "./routine-run-gate.ts";
import { busyWait, markStop, RunClock, runOverLimit, SlowStops, withBoundedStops, type StopState } from "./routine-bounds.ts"; import { keepUnreadableAside, readRoutineFile, UNREADABLE_RETRY_MS } from "./routine-file.ts";
import { noStartAlert, noStartSpacing, turnBackOn } from "./routine-no-start.ts"; import { afterRunSpacing, failureSpacingAlert, runSpacing } from "./routine-failure-spacing.ts"; import { blockingRun, recordSkip, type RoutineSkips } from "./routine-skips.ts";
import { restartRetryAt, startupDecision } from "./routine-restarts.ts"; import { routineHealthOf, type RoutineHealth } from "./routine-health.ts"; import { Occurrences, ROUTINE_TURN_GONE } from "./routine-occurrences.ts"; import type { Occurrence } from "./routine-ledger.ts";
import { CATCH_UP_MS, planOccurrence, settleRestored, staggered } from "./routine-catch-up.ts"; import { evictRuns } from "./routine-run-history.ts"; import { RunWatch } from "./routine-run-watch.ts"; import { scheduleSection, type ScheduleSection } from "./routine-schedule-report.ts";
import { EVENT_RETRY_WINDOW_MS, MAX_EVENT_RECEIPTS, type EventRunReceipt } from "./routine-event-receipts.ts"; import { waitsToWakeAgain, wakeGiveUp, wakeRetry, wakeRetryEnded, type WakeRetryMark } from "./routine-wake-retry.ts";
import { attachmentPathsOf, cloneAttachments } from "./routine-attachments.ts";
import { loadInstalledPackage, matchingRequestReceipt, rememberRequest } from "./routine-load.ts";
import { applyHolds, holdCauses, type AppliedHolds } from "./routine-holds.ts";
import { cancelUnfinishedRuns, interruptRunTurns } from "./routine-stops.ts";
import { sanitizeInput } from "./routine-input.ts";
import { applyCheckResult, codedLine, keptRunOutput, routineLine, runLineFields, type RoutineLine, type RoutineLineCodes, type RoutineTroubleCode } from "./routine-lines.ts";
import { checkHold, CHECK_BOOT_HOLD_MS, type CheckHold } from "./routine-check-pacing.ts";
import { resolveRoutineResultsThread, routineRunDefinition, type ResultsThreadAllocation } from "./routine-run-definition.ts";

export type { RoutineContextAttachment, RoutineIntervalWindow, RoutineRunStatus, RoutineRunTrigger };
export { intervalHasRestrictions } from "./routine-intervals.ts";
export { nextOccurrence, RoutineScheduleError } from "./routine-schedules.ts";
export type { RoutineIntervalSchedule, RoutineIntervalScheduleInput, RoutineSchedule, RoutineScheduleInput } from "./routine-schedules.ts";

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
  continuity?: boolean; sameConversation?: boolean;
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
  /** Its newest runs in a row whose cloud computer did not start, while its scheduled runs are spaced out for it. */
  noStartStreak?: number;
  weekRuns?: { ok: number; total: number };
  warning?: string;
  heldFor?: RoutineHoldCause;
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

export interface RoutineRun extends RoutineLineCodes, RoutineOwnerMark, WakeRetryMark {
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
  /** Set when the run waited once because the server had no room to start its engine (routine-recovery.ts). */
  roomWaited?: true;
  deferredNoticeAt?: number;
  /** How long a scheduled run has been seen queued behind its bot's other work, added up pass by pass (routine-bounds.ts `busyWait`). */
  busyMs?: number;
  /** On a `missed` row: the occurrences it stands for (routine-skips.ts). */
  skipped?: RoutineSkips;
  /** A queued run starts no earlier than this. */
  retryAt?: number;
  retried?: RoutineRetryCause;
  /** When its current wait began; read only while the run is waiting. */
  waitingSince?: number;
  asked?: RoutineRunAsk;
  /** Time spent waiting on the person's answers, which the run limit does not count. */
  waitedMs?: number;
  /** Time spent in status `running` since its current start, added up pass by pass: what the default run limit counts (routine-bounds.ts). */
  workedMs?: number;
  triggerSource?: RoutineRunTrigger;
  /** "app": a connected-app event started it; "wait": a wait's follow-up did (its triggerSource stays "webhook", an outside event). sameConversation: its trigger keeps one conversation (routine-same-conversation.ts). */
  eventSource?: "app" | "wait"; sameConversation?: true; /** A person's own "Run now" test of its webhook started it: a usage cap treats it as a run started by hand. */ byPerson?: true;
  webhookId?: string;
  deliveryId?: string;
  sourceThreadId?: string;
  resultsThreadId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  attention?: string;
  error?: string; partial?: boolean; /** It could not use the computer the person lends because its routine isn't confirmed as theirs: said on every run, never spacing it out. */ lendingRefused?: true;
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
  continuity?: boolean; sameConversation?: boolean;
  modelSelection?: ModelSelection | null;
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
  noStartOffsChecked?: true;
  ownerNotices?: RoutineOwnerNotice[];
  holds?: RoutineHoldCause[];
}


export type RoutineRequestOwner = Pick<RoutineRequestReceipt, "requestId" | "messageId" | "botId" | "threadId">;

function routineRequestOwnerKey(owner: RoutineRequestOwner): string {
  return JSON.stringify([owner.requestId, owner.messageId, owner.botId, owner.threadId]);
}

/** What a routine's checks found: items for one AI run, a sentence while an app cannot be read, and the next time they
 * have something to do on time. */
export interface RoutineCheckResult { run?: { prompt: string; key: string }; trouble?: string; troubleCode?: string; wakeAt?: number }

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
  /** Why this bot takes no runs now (or not `run`), in the person's words; null when it does. */ pausedText?: (botId: string, run?: RoutineRun) => string | null; /** The person paused this bot: its runs are let go quietly, not failed into To review. */ held?: (botId: string) => boolean; /** A reached usage cap (host/usage-cap-gate.ts): `capSkip` for a scheduled occurrence, which is counted on one `missed` row per cap and period and never switches the routine off; `capText` for a run already queued. */ capSkip?: (botId: string, routineId: string) => { behind: string; resetsAt: number; words(count: number): RoutineLine } | null; capText?: (botId: string, trigger: RoutineRunTrigger) => string | null;
  goalState?: (groupId: string | undefined, coordinatorBotId: string) => "ready" | "busy" | "missing";
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
    onDispatchError: (message: string) => void, runId: string,
  ) => Promise<void>;
  startGoal?: (
    groupId: string | undefined,
    threadId: string,
    prompt: string,
    coordinatorBotId: string,
    runId: string,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  interruptTurn?: (botId: string, threadId: string) => Promise<void>;
  interruptGoal?: (
    groupId: string | undefined,
    threadId: string,
    outcome?: { status: "stopped" | "limit-reached"; detail: string },
  ) => Promise<void>;
  onRunChanged?: (run: RoutineRun) => void;
  /** The thread's engine session will resume holding this message, so a second start need not send it again. */ promptSaid?: (threadId: string, prompt: string) => boolean;
  onRunFailed?: (run: RoutineRun, alert?: RoutineAlert | null) => void;
  onRunDeferred?: (run: RoutineRun, alert?: RoutineAlert) => void;
  /** A run a restart cut off, before it starts again or fails: its old turn's work must not resume as well. */
  onRunCut?: (run: RoutineRun) => void;
  hasPendingDelegations?: (threadId: string) => boolean; /** What a run a restart cut ends with in place of starting again, or null (memory-freeze-restart.ts). */ restartCut?: (threadId: string, startedAt: number | undefined) => string | null; /** Why a run that ended well in this thread must fail instead (a hand-off refused, the lent computer refused), once; null when nothing was. */ refusedHandoff?: (threadId: string) => string | RefusedRunLine | null;
  /** The turn in this thread is a routine's own, not one a person started there while its run waits on teammates. */
  routineTurn?: (threadId: string) => boolean; /** The thread's latest turn is one a person started there by typing (false when not known, e.g. after a restart). */ personTurn?: (threadId: string) => boolean;
  /** When an engine's usage limit resets (epoch ms), or null while that is not known. */
  limitResetAt?: (engine: string) => number | null;
  /** The bot has a backup engine to continue on when its own engine's usage limit refuses a run, or it is signed out. */
  limitBackup?: (botId: string, scope?: "engine" | "model" | "credits" | "signed-out") => boolean;
  /** Work this thread handed to another bot is still open, so its wait is not only on the person. */
  handedOffWorkLive?: (threadId: string) => boolean;
  launchId?: string;
  /** A Cloud home woken from a sleep it was stopped for (server/cloud-power.ts): not a startup, so no "run on startup". */
  skipStartupRuns?: boolean; /** What a run needs before it starts (its cloud computer awake and answering): null when nothing, else resolves null when ready or with why the run cannot start. `preparing` is the run's line meanwhile. Only a run nobody started by hand is held; the signal aborts once the run no longer waits to start. */ prepareRun?: RunPreparation<RoutineRun>; preparing?: string;
  checks?: RoutineChecks;
  /** routines.json, unreadable at start, can be read now. True: the host starts the process afresh instead, so that what
   * settles at start (who owns a Cloud's routines, its holds) sees them before any runs; nothing is loaded here. */
  restartsToReload?: () => boolean;
  /** routines.json became readable again while this process ran, and its routines are loaded. */
  onReadable?: () => void;
  /** This copy is frozen by a move to another home (move-freeze.ts): nothing here is turned back on. */
  moveFrozen?: () => boolean;
  /** The machine this runs on, so a run another machine holds a lease on is told from one this machine left behind; and whether it is a Cloud home, for the words of a missed run. */
  home?: { machine?: string; cloud?: boolean };
  /** Whether the run's conversation has a turn working or about to start; null when that cannot be told. Without it no run is taken for lost. */
  turnLive?: (run: RoutineRun) => boolean | null;
}

const WAKE_HORIZON_MS = 60 * 60_000;

export const ROUTINE_RESTARTED = "OpenMausBot restarted while this routine was running";
const MAX_RUNS = 2_000;
const earliest = (...times: Array<number | null>): number | null => times.reduce<number | null>((first, at) => at === null ? first : first === null ? at : Math.min(first, at), null);
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
  private readonly file: string; private readonly disk: OwnedFile;
  private readonly now: () => number;
  private readonly options: RoutineManagerOptions;
  private routines: Routine[] = [];
  /** Written back unchanged on every save, so unrelated work never deletes a repairable row. */
  private unloadedRoutines: Routine[] = [];
  private runs: RoutineRun[] = [];
  private routineRequestReceipts: RoutineRequestReceipt[] = [];
  private webhookRunReceipts: EventRunReceipt[] = [];
  private timer: DueTimer | null = null;
  private startupRunsQueued = false;
  private startupLaunchId: string | undefined;
  private ticking = false;
  private closing = false;
  private ownerNotices: RoutineOwnerNotice[] = [];
  /** Why routines are held now (routine-holds.ts): a change between two of these pauses or frees routines. */
  private holds: RoutineHoldCause[] = [];
  private readonly failureFacts = new Map<string, RoutineFailureFacts>();
  /** Saves are refused while unreadable, so an empty state never overwrites the file; malformedAttachments: a saved list failed to load, so no clear may trust attachmentPaths(). */
  private unreadable = false; private malformedAttachments = false; private noStartOffsChecked = false; private turnedBackOn: Routine[] = [];
  private readonly clock = new RunClock(); private readonly slowStops = new SlowStops(() => this.now(), (threadId, state) => this.stopChanged(threadId, state));
  private frozenPending = false;
  private readonly bootedAt: number;
  private readonly checking = new Set<string>(); private readonly progress = new RunProgressSave(() => this.file, () => this.save()); private readonly gate = createRunGate<RoutineRun>((run, signal) => this.options.prepareRun?.(cloneRun(run), signal) ?? null, () => this.tickInBackground());
  private readonly ledger: Occurrences; private readonly watch: RunWatch; private passedAt = -Infinity;

  constructor(options: RoutineManagerOptions) {
    this.options = withBoundedStops(options, this.slowStops);
    this.file = options.file ?? join(DATA_DIR, "routines.json"); this.disk = new OwnedFile(this.file, { mode: 0o600 });
    this.now = options.now ?? Date.now;
    this.bootedAt = this.now(); this.ledger = new Occurrences(this.file, this.now, options.home?.machine); this.watch = new RunWatch(options.turnLive);
    this.load();
  }

  /** Reads routines.json into memory; false while it is there but cannot be read, when nothing in memory is trusted or saved. */
  private load(read = readRoutineFile(this.file, this.now())): boolean {
    const before = this.unreadable;
    this.unreadable = read.state === "unreadable";
    // The file's path and a fixed reason only: its content never reaches the log.
    if (read.state === "unreadable" && !before) console.error(`routines: ${this.file} cannot be read (${read.reason}), so no routine runs until it can; it is left as it is, with a copy at ${keepUnreadableAside(this.file) ?? "no path (the copy failed)"}`);
    if (read.state !== "ok") return read.state === "missing";
    ({ routines: this.routines, unloadedRoutines: this.unloadedRoutines, runs: this.runs, malformedAttachments: this.malformedAttachments, routineRequestReceipts: this.routineRequestReceipts,
      webhookRunReceipts: this.webhookRunReceipts, frozenPending: this.frozenPending, ownerNotices: this.ownerNotices, holds: this.holds,
      startupLaunchId: this.startupLaunchId, noStartOffsChecked: this.noStartOffsChecked } = read);
    this.disk.loaded(read.text);
    const cut = settleRestored(this.routines, this.runs, this.ledger.restoredThrough, this.now(), (routine, past) => this.advancePastOccurrence(routine, past, past)).map(cloneRun); this.ledger.restoredThrough = null;
    let restarts = 0;
    for (const run of this.runs.filter((candidate) => candidate.status === "running" || candidate.status === "waiting")) {
      const turnRan = run.status === "running"; settleAsk(run, undefined, this.now());
      if (run.threadId && run.target === "bot" && this.options.hasPendingDelegations?.(run.threadId) === true) {
        this.wait(run, ROUTINE_HANDOFF_WAIT);
        continue;
      } const froze = run.threadId && turnRan ? this.options.restartCut?.(run.threadId, run.startedAt) ?? null : null; // A run waiting on hand-offs keeps waiting; one whose turn ran through a memory freeze ends.
      if (froze !== null || !requeueOnce(run, "restarted", ROUTINE_RESTARTED, this.now(), restartRetryAt(this.now(), restarts++, this.ledger.retryAfterBoot(run)))) {
        Object.assign(run, { status: "failed", error: froze ?? ROUTINE_RESTARTED, attention: undefined, finishedAt: this.now() } satisfies Partial<RoutineRun>);
        if (run.target === "room-goal") run.goalStatus = "failed";
      }
      cut.push(cloneRun(run));
    }
    const look = !this.noStartOffsChecked && this.options.moveFrozen?.() !== true;
    const back = look ? turnBackOn(this.routines, this.runs, this.holds[0], this.now(), (schedule, now) => this.initialOccurrence(schedule, now)) : [];
    // The look is noted with the next save: reading a file in which nothing changes writes nothing.
    if (look) { this.noStartOffsChecked = true; this.turnedBackOn = back.filter((routine) => routine.enabled); } this.ledger.observe(this.routines, this.runs, false)();
    if (cut.length > 0 || back.length > 0) this.saveLater();
    for (const run of cut) {
      if (run.threadId) this.options.onRunCut?.(run);
      this.notifyRunChanged(run);
      if (run.status === "failed") this.options.onRunFailed?.(run);
    }
    return true;
  }

  /** Files every saved routine and run names, unloaded rows too; null while routines.json is unreadable or a row's attachments are malformed, so nothing can clear them. */
  attachmentPaths(): string[] | null { return this.unreadable || this.malformedAttachments ? null : attachmentPathsOf([...this.routines, ...this.unloadedRoutines, ...this.runs]); }

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
    this.saveLater();
  }

  private routineWithHealth(routine: Routine): Routine {
    const outcomes = outcomesNewestFirst(this.runs, routine.id);
    const success = outcomes.findIndex(run => run.status === "completed");
    const failures = success < 0 ? outcomes.length : success;
    const { installedPackage: _installedPackage, ...visible } = cloneRoutine(routine);
    const warning = routineHostWarning(routine), week = weekRuns(this.runs, routine.id, this.now()), spaced = noStartSpacing(routine, this.runs);
    return { ...visible, ...(failures ? { failureStreak: failures } : {}), ...(spaced ? { noStartStreak: spaced.streak } : {}), ...(week ? { weekRuns: week } : {}), ...(warning ? { warning } : {}) };
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

  /** Whether routines.json cannot be read, and how often stopping a turn outlasted its wait: for the app and the health report. */
  schedulerState(): { unreadable: boolean; slowStops: number } { return { unreadable: this.unreadable, slowStops: this.slowStops.count }; }
  health(cap: number): RoutineHealth[] { return routineHealthOf(this.routines, this.runs, cap); }
  /** The health report's `schedule` section (routine-schedule-report.ts), from the ledger as it is now. */
  scheduleReport(): ScheduleSection {
    const next = this.unreadable ? [] : this.routines.filter((routine) => routine.enabled && !routine.checks && routine.nextRunAt != null && this.targetState(routine) !== "missing")
      .map((routine) => ({ at: routine.nextRunAt!, paused: routine.target !== "room-goal" && Boolean(this.options.pausedText?.(routine.botId)) }));
    return scheduleSection({ seq: this.ledger.sequence(this.unreadable), unreadable: this.unreadable || this.ledger.degraded, slowStops: this.slowStops.count, next, records: this.ledger.ledger.all(), boot: this.ledger.counts, now: this.now() });
  }
  /** A routine's scheduled occurrences as the ledger holds them, newest first: ids, times, counts and fixed words. */
  occurrences(routineId: string): Occurrence[] { return this.ledger.ledger.ofRoutine(routineId).sort((a, b) => b.dueAt - a.dueAt).map((record) => structuredClone(record)); }
  /** Routines an earlier version had switched off that this start turned back on, handed over once, for a line to their bots. */
  takeTurnedBackOn(): Routine[] { return this.turnedBackOn.splice(0).map(cloneRoutine); }
  /** Each routine with the next run it will really make: one whose runs are spaced out is not due for the occurrences it skips. */
  private planned(routines: readonly Routine[]): Routine[] { return routines.map((routine) => routine.checks || runsOnce(routine.schedule) ? routine : afterRunSpacing(routine, this.runs, this.now(), nextOccurrence)); }
  wakeHold(horizonMs = WAKE_HORIZON_MS) { return wakeHoldOf(this.planned(this.routines), this.runs, this.now(), horizonMs); }
  /** A Cloud home's sleep check (server/routine-due.ts). */
  hasActiveRuns(): boolean { return activeRunsOf(this.runs, this.now()); }
  nextDueAt(): number | null { return nextDueOf(this.planned(this.routines.filter((routine) => routine.target === "room-goal" || !this.options.pausedText?.(routine.botId))), this.runs, this.now()); }

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
    this.saveLater();
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
      continuity: patch.continuity ?? routine.continuity, sameConversation: patch.sameConversation ?? routine.sameConversation,
      modelSelection: Object.hasOwn(patch, "modelSelection") ? patch.modelSelection : routine.modelSelection,
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
    let stopped: ReturnType<typeof cancelUnfinishedRuns> | undefined;
    this.commitMutation(() => {
      Object.assign(routine, clean, {
        resultsThreadId: destination.resultsThreadId,
        nextRunAt,
        // updatedAt doubles as the confirmation cards' optimistic revision: keep it monotonic within one ms.
        updatedAt: Math.max(now, routine.updatedAt + 1),
      });
      if (patch.enabled !== undefined) delete routine.heldFor;
      for (const key of ["continuity", "sameConversation", "modelSelection", "overlap", "runOnStartup", "access", "deliver"] as const) if (!clean[key]) delete routine[key];
      if (!clean.checks) for (const key of ["checks", "checkedAt", "checkTrouble", "checkTroubleCode", "wakeAt"] as const) delete routine[key];
      if (Object.hasOwn(patch, "timeoutMinutes") && patch.timeoutMinutes == null) {
        delete routine.timeoutMinutes;
      }
      if (patch.enabled === false) stopped = cancelUnfinishedRuns(this.runs, routine.id, this.now(), "paused");
      if (request) this.rememberRoutineRequest(request, routine.id, now);
    }, discardResults);
    for (const run of stopped?.cancelled ?? []) this.emitRun(run);
    interruptRunTurns(stopped?.waited ?? [], this.options);
    this.emitRoutine(routine);
    return this.routineWithHealth(routine);
  }

  remove(id: string, request?: RoutineRequestCommitFor<"delete">): boolean {
    this.assertWritable();
    if (request && this.matchingRoutineRequestReceipt(request)) return true;
    const at = this.routines.findIndex((r) => r.id === id);
    if (at === -1) return false;
    const changedRuns: RoutineRun[] = [];
    let stopped: ReturnType<typeof cancelUnfinishedRuns> | undefined;
    this.commitMutation(() => {
      this.routines.splice(at, 1);
      for (const run of this.runs) {
        if (run.routineId !== id || run.status === "queued" || run.status === "waiting" || run.seenAt || !isRoutineProblemRun(run)) continue;
        run.seenAt = this.now();
        changedRuns.push(run);
      }
      stopped = cancelUnfinishedRuns(this.runs, id, this.now(), "deleted");
      if (request) this.rememberRoutineRequest(request, id, this.now());
    });
    for (const run of [...stopped!.cancelled, ...changedRuns]) this.emitRun(run);
    interruptRunTurns(stopped!.waited, this.options);
    this.options.emit?.({ kind: "routine.deleted", routineId: id });
    return true;
  }

  /** A deleted bot's schedules go with it, or with `routineId` that one only (one person's alone, gone as they leave a team): each is removed, its unfinished runs stop, and its run history is dropped. */
  removeForBot(botId: string, routineId?: string) {
    for (const routine of this.routines.filter((candidate) => candidate.botId === botId && (routineId === undefined || candidate.id === routineId))) this.remove(routine.id);
    for (const run of this.runs) {
      if (run.botId !== botId || (routineId !== undefined && run.routineId !== routineId) || !["queued", "running", "waiting"].includes(run.status)) continue;
      run.status = "cancelled";
      if (run.target === "room-goal") run.goalStatus = "stopped";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = routineId === undefined ? "The assigned bot was deleted" : "The routine was deleted";
      this.emitRun(run);
      interruptRunTurns([run], this.options);
    }
    const kept = this.runs.filter((run) => run.botId !== botId || (routineId !== undefined && run.routineId !== routineId));
    if (kept.length !== this.runs.length) this.commitMutation(() => { this.runs = kept; });
  }

  disableForGroup(groupId: string) {
    let changed = false;
    for (const routine of this.routines) {
      if (routine.target !== "room-goal" || routine.groupId !== groupId || (!routine.enabled && !routine.heldFor)) continue;
      delete routine.heldFor;
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
    if (changed) this.saveLater();
  }

  runNow(id: string, request?: RoutineRequestCommitFor<"run_now">): RoutineRun | null {
    if (this.closing) return null;
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
    queueMicrotask(() => this.tickInBackground());
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
    webhookId: string; webhookName: string; prompt: string; botId: string; runOn: RoutineRunOn; deliveryId: string; receivedAt: number;
    eventSource?: "app" | "wait"; sameConversation?: boolean; byPerson?: boolean;
    /** Where the run reports, instead of the event's own results chat. */
    resultsThreadId?: string;
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
      resultsThreadId: input.resultsThreadId ?? this.options.eventResultsThread?.(input), ...(input.eventSource ? { eventSource: input.eventSource } : {}), ...(input.sameConversation ? { sameConversation: true } : {}), ...(input.byPerson ? { byPerson: true } : {}),
    };
    this.commitEvent(run, input.deliveryId, () => { this.runs.push(run); });
    return cloneRun(run);
  }

  /** Adds an outside event to its trigger's run that has not started yet, so a burst becomes one run. Null when there
   *  is no such run with the same conversation setting, or `merge` declines (the run is full). */
  mergeIntoQueuedRun(webhookId: string, deliveryId: string, sameConversation: boolean, merge: (prompt: string) => string | null): { id: string } | null {
    this.assertWritable();
    const existing = this.webhookRunReceipt(webhookId, deliveryId);
    if (existing) return existing;
    const run = this.runs.findLast((candidate) => candidate.webhookId === webhookId && candidate.status === "queued" && !candidate.threadId && (candidate.sameConversation === true) === sameConversation);
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
    queueMicrotask(() => this.tickInBackground());
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
    if (changed) this.saveLater();
  }

  async cancelRun(id: string, reason?: string): Promise<RoutineRun | null> {
    const run = this.runs.find((r) => r.id === id);
    if (!run || !["queued", "running", "waiting"].includes(run.status)) return null;
    run.status = "cancelled";
    if (run.target === "room-goal") run.goalStatus = "stopped";
    run.attention = undefined;
    run.finishedAt = this.now();
    if (reason) run.error = reason;
    this.saveLater();
    this.emitRun(run);
    if (run.threadId) {
      if (run.target === "room-goal") {
        await this.options.interruptGoal?.(run.groupId, run.threadId).catch(() => {});
      } else {
        await this.options.interruptTurn?.(run.botId, run.threadId).catch(() => {});
      }
    }
    queueMicrotask(() => this.tickInBackground());
    return cloneRun(run);
  }

  markSeen(id: string): RoutineRun | null {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return null;
    if (!run.seenAt) {
      run.seenAt = this.now();
      this.saveLater();
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
    if (moved.length) this.saveLater();
    for (const routine of moved) this.emitRoutine(routine);
    return moved.length;
  }

  /** The engines' reset times changed: each limit-reset routine that is on takes its engine's new time, once the run it owes a passed reset was made (limit-reset-owed.ts). */
  retimeLimitResets(): number {
    const moved = this.routines.filter((routine) => {
      if (!routine.enabled || routine.schedule.type !== "limit_reset" || limitResetRunOwed(routine, this.runs, this.now())) return false;
      const schedule = this.timedSchedule(routine.schedule, routine.id);
      if (schedule.type !== "limit_reset" || (schedule.at === routine.schedule.at && schedule.at === routine.nextRunAt)) return false;
      routine.schedule = schedule;
      routine.nextRunAt = schedule.at;
      return true;
    });
    if (moved.length) this.saveLater();
    for (const routine of moved) this.emitRoutine(routine);
    return moved.length;
  }

  /** Moves only the next run to `until`; the runs after it keep their schedule. A limit-reset routine has no time to move. */
  /** Why routines wait now (routine-holds.ts). Returns the causes that began and paused a routine, for one line to the owner. */
  holdFor(causes: readonly RoutineHoldCause[]): RoutineHoldCause[] {
    const after = holdCauses(causes);
    if (this.unreadable || after.join() === this.holds.join()) return [];
    let held: AppliedHolds<Routine, RoutineRun> | undefined;
    this.commitMutation(() => { held = applyHolds(this.routines, this.runs, this.holds, after, this.now(), (schedule, now) => this.initialOccurrence(schedule, now)); this.holds = after; });
    for (const run of held!.cancelled) this.emitRun(run);
    for (const routine of [...held!.paused, ...held!.resumed]) this.emitRoutine(routine);
    return held!.paused.length ? held!.began : [];
  }

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
  private tickInBackground(): void { this.tick().catch((error) => console.error("routines: a scheduler pass failed", error)); }

  start() {
    if (this.closing || this.timer) return;
    if (!this.startupRunsQueued) this.startupRunsQueued = this.queueStartupRuns();
    this.timer = startDueTimer({ run: () => this.tick(), now: this.now, onError: (error) => console.error("routines: a scheduler pass failed", error),
      next: () => this.unreadable ? this.now() + UNREADABLE_RETRY_MS : earliest(schedulerDueOf(this.routines, this.runs, this.now(), this.bootedAt + CHECK_BOOT_HOLD_MS, (routine) => this.targetState(routine) === "missing"), this.ledger.beatDueAt(), this.watch.dueAt(this.runs, this.now())) });
  }

  stop() {
    this.timer?.stop(); this.timer = null;
    try { this.progress.flush(); } catch (error) { console.error("routines: could not save run progress", error); }
  }

  /** At shutdown: a run whose turn the shutdown cuts stays running on disk, for the next start to pick up once. */
  close() {
    this.closing = true; this.progress.atOnce();
    this.stop(); this.ledger.close();
  }

  private queueStartupRuns(): boolean {
    if (this.options.skipStartupRuns) return true;
    const launchId = this.options.launchId, now = this.now();
    if (launchId !== undefined && launchId === this.startupLaunchId) return true;
    const flagged = this.routines.filter((routine) =>
      routine.enabled && routine.runOnStartup && routine.schedule.type !== "once" &&
      (routine.schedule.type !== "interval" || routine.schedule.endsAt === undefined || now <= routine.schedule.endsAt));
    const marked = flagged.filter((routine) =>
      !(routine.nextRunAt != null && routine.nextRunAt <= now && now - routine.nextRunAt <= CATCH_UP_MS) &&
      !this.runs.some((run) => run.routineId === routine.id && ["queued", "running", "waiting"].includes(run.status)));
    if (marked.length === 0 && launchId === undefined) return true;
    const previousLaunchId = this.startupLaunchId, decision = startupDecision(launchId, previousLaunchId, now), runs: RoutineRun[] = [], allocations: ResultsThreadAllocation[] = [];
    try {
      this.commitMutation(() => {
        if (decision.run && decision.marker !== undefined) this.startupLaunchId = decision.marker;
        for (const routine of marked) {
          const startup = () => Object.assign(this.newRun(routine, now, false, allocations), { triggerSource: "startup" as const });
          if (!decision.run) { runs.push(recordSkip(this.runs, startup, { behind: decision.behind(routine.id), why: "routines.server.part.restartedSoon" }, now, now).row); continue; }
          runs.push(startup());
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
    if (this.closing || this.ticking) return;
    this.ticking = true;
    // A queued run's wait crosses its next minute each pass it is seen so; those marks ride the pass's next whole write, together, not one per run (server/save-batch.ts).
    let batched = false;
    const openSaves = () => { if (!batched) { beginSaves(); batched = true; } }, closeSaves = () => { if (batched) { endSaves(); batched = false; } };
    try {
      const now = this.now(); this.gate.sweep((id) => this.runs.some((run) => run.id === id && run.status === "queued"));
      if (this.unreadable) {
        const read = readRoutineFile(this.file, now);
        if (read.state === "unreadable" || this.options.restartsToReload?.() === true) return;
        this.load(read); this.startupRunsQueued = this.queueStartupRuns();
        this.options.onReadable?.(); for (const routine of this.routines) this.emitRoutine(routine);
      }
      for (const threadId of this.slowStops.sweep()) interruptRunTurns(this.runs.filter((run) => run.threadId === threadId).slice(-1), this.options);
      this.ledger.beat(); for (const run of this.watch.lost(this.runs, now)) this.settleFailure(run, ROUTINE_TURN_GONE, {});
      for (const run of this.runs) {
        const over = runOverLimit(run, this.clock, now), ended = wakeRetryEnded(run, now, this.routines.find((routine) => routine.id === run.routineId)); if (ended !== null) { this.failRun(run, ended); continue; }
        if (over) await this.stopRun(Object.assign(run, over.codes), over.text, "limit-reached");
      }
      const isDue = (routine: Routine) => !this.closing && routine.enabled && this.targetState(routine) !== "missing" && (!routine.checks
        ? routine.nextRunAt != null && routine.nextRunAt <= now
        : now >= this.bootedAt + CHECK_BOOT_HOLD_MS && [routine.nextRunAt, routine.wakeAt].some((at) => at != null && at <= now));
      // An unanswered wait gives way to its routine's next occurrence, which would otherwise be skipped behind it.
      for (const routine of this.routines.filter(isDue)) {
        if (routine.checks || runsOnce(routine.schedule) || now - routine.nextRunAt! > CATCH_UP_MS) continue;
        const stale = this.runs.filter((run) => run.routineId === routine.id && supersededBy(routine.nextRunAt!, run, this.options.handedOffWorkLive));
        for (const run of stale) await this.cancelRun(run.id, ROUTINE_SUPERSEDED);
      }
      const dueRoutines = this.routines.filter(isDue);
      const scheduledRuns: RoutineRun[] = [], countedSkips: RoutineRun[] = []; let lateStarts = 0;
      const allocations: ResultsThreadAllocation[] = [], checks: Array<{ id: string; hold?: CheckHold }> = [];
      openSaves();
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
            const plan = planOccurrence(routine, now, this.options.home?.cloud === true, this.passedAt >= routine.nextRunAt!), scheduledFor = plan.scheduledFor;
            if (this.ledger.decided(routine.id, scheduledFor)) { this.advancePastOccurrence(routine, now, plan.through); continue; }
            const once = runsOnce(routine.schedule), blocker = once ? undefined : blockingRun(this.runs, routine.id), spaced = once ? null : runSpacing(routine, this.runs);
            const scheduledQueued = this.runs.some(run => run.routineId === routine.id && run.status === "queued" &&
              (run.triggerSource ?? (run.manual ? "manual" : "schedule")) === "schedule");
            const capped = routine.target !== "room-goal" && this.options.pausedText?.(routine.botId) ? null : this.options.capSkip?.(routine.botId, routine.id);
            const skipFor = capped ?? (blocker && !(routine.overlap === "queue" && !scheduledQueued) ? { behind: blocker.run.id, why: blocker.why, waitingSince: blocker.waitingSince }
              : spaced && spaced.until > now ? { behind: spaced.behind, why: spaced.why } : undefined);
            if (!skipFor) {
              if (plan.older) countedSkips.push(Object.assign(this.newRun(routine, plan.older.scheduledFor, false, allocations), plan.older.fields));
              scheduledRuns.push(Object.assign(this.newRun(routine, scheduledFor, false, allocations), plan.fields, plan.late ? staggered(now, lateStarts++) : {}));
            } else {
              const skip = recordSkip(this.runs, () => this.newRun(routine, plan.through, false, allocations), skipFor, plan.through, now, plan.count > 1 ? { count: plan.count - 1, scheduledFor: plan.first } : undefined);
              (skip.tell ? scheduledRuns : countedSkips).push(skip.row);
              if (!capped) { routine.skippedRuns = Math.min(Number.MAX_SAFE_INTEGER, (routine.skippedRuns ?? 0) + plan.count); routine.lastSkippedAt = plan.through; }
              else if (once) { if (routine.schedule.type === "once") routine.schedule = { type: "once", at: capped.resetsAt }; routine.nextRunAt = capped.resetsAt; continue; } // a capped once-only run is not used up: it runs when the cap resets
            }
            this.advancePastOccurrence(routine, now, plan.through);
          }
        }, () => this.discardResultsThreads(allocations));
      }
      // Publish only after the scheduler batch is durable: reporting may persist transcript cards.
      for (const routine of dueRoutines) this.emitRoutine(routine);
      for (const run of scheduledRuns) this.emitRun(run);
      // A counted skip the owner is not told about changes its row only: no card, no notice.
      for (const run of countedSkips) this.options.emit?.({ kind: "routine.run", run: cloneRun(run) });
      for (const run of scheduledRuns) {
        if (run.status === "missed") this.options.onRunFailed?.(cloneRun(run));
      }
      for (const { id, hold } of checks) this.runChecks(id, hold).catch((error) => console.error(`routines: the checks of ${id} failed`, error));

      // Oldest first, by id: a rollback across awaits can replace the run objects, and the array with them.
      let indexed: RoutineRun[] | null = null, byId = new Map<string, RoutineRun>();
      for (const id of this.runs.map((run) => run.id)) {
        if (this.closing) return; openSaves();
        if (indexed !== this.runs) [indexed, byId] = [this.runs, new Map(this.runs.map((run) => [run.id, run]))];
        const run = byId.get(id);
        if (!run || run.status !== "queued" || (run.retryAt ?? 0) > now) continue;
        const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
        const definition = triggerSource === "schedule"
          ? this.routines.find((routine) => routine.id === run.routineId)
          : undefined;
        if (definition?.schedule.type === "interval") {
          const latest = latestIntervalOccurrence(definition.schedule, now);
          if (latest !== null && latest > run.scheduledFor) {
            // A stamp the app is shown is on disk when it is shown (reporting persists cards): these stamps save at once, not with the pass's waiting marks.
            run.scheduledFor = latest;
            this.save(); this.emitRun(run);
          }
          const requiresCurrentDayOccurrence =
            definition.schedule.weekdays !== undefined || definition.schedule.window !== undefined;
          const mayDispatch = intervalAllowsOccurrence(definition.schedule, now) &&
            (!requiresCurrentDayOccurrence || (latest !== null && isSameLocalDay(latest, now)));
          if (!mayDispatch) {
            if (waitsToWakeAgain(run)) this.failRun(run, wakeGiveUp(run, definition)); else if (nextOccurrence(definition.schedule, now) === null) {
              this.failRun(run, "The routine ended before this scheduled run could start", "missed");
            }
            continue;
          }
        }
        const checked = triggerSource === "webhook" || run.checkKey ? undefined : this.routines.find((routine) => routine.id === run.routineId && routine.checks);
        if (checked) {
          this.runChecks(checked.id, checkHold(this.runs, checked.id, now, run.id), run.id).catch((error) => console.error(`routines: the checks of ${checked.id} failed`, error));
          continue;
        }
        const held = (triggerSource === "schedule" || run.sameConversation) && this.runs.some(other =>
          other.id !== run.id && other.routineId === run.routineId && (["running", "waiting"].includes(other.status) || this.options.turnLive?.(other) === true)) ||
          this.runs.some((other) => other.routineId === run.routineId && this.slowStops.holds(other.threadId));
        const state = held ? "busy" : this.targetState(run);
        if (state === "busy") {
          if (run.deferredAt == null) {
            run.deferredAt = now;
            this.save(); this.emitRun(run);
          }
          if (run.deferredNoticeAt == null && !run.checkKey && now - run.deferredAt >= ROUTINE_DEFERRAL_NOTICE_MS) {
            run.deferredNoticeAt = now;
            this.save(); this.emitRun(run); this.options.onRunDeferred?.(cloneRun(run));
          }
          const busy = busyWait(run, this.clock, triggerSource === "schedule" && !held && run.checkKey === undefined, now);
          if (busy.missed) this.failRun(Object.assign(run, busy.missed.codes), busy.missed.text, "missed");
          else if (busy.changed) this.saveLater();
          continue;
        }
        if (state === "missing") { this.failRun(run, this.missingTargetMessage(run.target)); continue; }
        const paused = run.target === "room-goal" ? null : this.options.pausedText?.(run.botId, run);
        if (!this.ledger.ready(run)) continue; if (this.ledger.startedElsewhere(run)) { const line = codedLine("error", "routines.server.duplicate"); Object.assign(run, line.codes); void this.cancelRun(run.id, line.text); continue; }
        if (paused) { if (triggerSource !== "manual" && this.options.held?.(run.botId)) void this.cancelRun(run.id, paused); else this.failRun(run, paused); continue; } const startedBy = run.byPerson ? "manual" : triggerSource, capped = this.options.capText?.(run.botId, startedBy); if (capped) { if (startedBy === "manual") this.failRun(run, capped); else void this.cancelRun(run.id, capped); continue; } const gated = triggerSource === "manual" ? false : this.gate.hold(run); if (gated === true) { if (this.options.preparing && run.attention !== this.options.preparing) { run.attention = this.options.preparing; this.emitRun(run); } continue; } if (gated) { const again = wakeRetry(run, gated, definition, this.now()); if (again === true) { this.save(); this.emitRun(run); } else this.failRun(run, again); continue; }
        const startedAt = this.now();
        const suffix = ` · ${new Date(startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
        const title = `${run.routineName.slice(0, 80 - suffix.length).trimEnd()}${suffix}`;
        const joined = run.threadId || (run.target === "room-goal" ? null : this.options.joinConversation?.(run)) || null;
        const task = joined
          ? { threadId: joined }
          : run.target === "room-goal"
          ? run.groupId
            ? this.options.createGoalTask?.(run.groupId, title) ?? null
            : this.options.createTask(run.botId, title, run)
          : this.options.createTask(run.botId, title, run);
        if (!task) {
          this.failRun(run, run.target === "room-goal"
            ? "Could not create a room task for this goal"
            : "Could not create a task for this run");
          continue;
        }
        Object.assign(run, { threadId: task.threadId, startedAt, status: "running" } satisfies Partial<RoutineRun>); this.clock.from(run, "workedMs", startedAt); delete run.workedMs; this.clock.stop(run, "busyMs", true);
        try { this.save(); } catch (error) { Object.assign(run, { status: "queued", startedAt: undefined } satisfies Partial<RoutineRun>); throw error; }
        this.emitRun(run); closeSaves(); // the handoff yields: the start's write carried the pass's waiting marks, and later ones land at the pass's end
        try {
          const prompt = run.prompt ?? this.routines.find((r) => r.id === run.routineId)?.prompt;
          if (!prompt) {
            this.failThread(task.threadId, "The routine was deleted before it could start", { cause: "refused" });
            continue;
          }
          const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
          if (run.target === "room-goal") {
            if (!this.options.startGoal) {
              this.failThread(task.threadId, "Room goal routines are unavailable");
              continue;
            }
            await this.options.startGoal(
              run.groupId,
              task.threadId,
              prompt,
              run.botId,
              run.id,
              (message) => this.failThread(task.threadId, message, { cause: "refused" }),
            );
          } else {
            await this.options.startTurn(
              run.botId,
              task.threadId,
              startPrompt(run, prompt, composeExecutionPrompt({ id: run.routineId, name: run.routineName, trigger: triggerSource, runOn: run.runOn ?? "maus" }, prompt, run.attachments, continuityCarry(run, this.routines, this.runs)), (first) => this.options.promptSaid?.(task.threadId, first) === true),
              run.runOn ?? "maus",
              triggerSource,
              (message) => this.failThread(task.threadId, message, { cause: "refused" }), run.id,
            );
          }
        } catch (error) {
          this.failThread(task.threadId, error instanceof Error ? error.message : String(error), dispatchRefusal(error));
        }
      }
    } finally {
      closeSaves(); this.ticking = false; this.passedAt = this.now();
    }
  }

  /** Runs a routine's checks: what needs the AI becomes one run, or fills `manual`, the queued run the person started.
   * Nothing new leaves no run behind a scheduled check, and a quiet completed one behind a manual check. */
  private async runChecks(routineId: string, hold: CheckHold | undefined, manual?: string): Promise<void> {
    const hook = this.options.checks, key = manual ?? routineId, routine = this.routines.find((candidate) => candidate.id === routineId);
    if (this.closing || !hook || !routine || this.checking.has(key)) return;
    const revision = routine.updatedAt;
    this.checking.add(key);
    let result: RoutineCheckResult;
    try {
      result = await hook.check(cloneRoutine(routine), { manual: manual !== undefined, ...(hold ? { hold } : {}) });
    } catch (error) {
      console.error(`routines: the checks of ${routineId} failed`, error);
      result = { trouble: routineLine("routines.server.checksFailed"), troubleCode: "routines.server.checksFailed" };
    } finally {
      this.checking.delete(key);
    }
    const current = this.routines.find((candidate) => candidate.id === routineId);
    const queued = manual === undefined ? undefined : this.runs.find((run) => run.id === manual && run.status === "queued");
    if (this.closing || !current?.checks || (manual === undefined ? !current.enabled : !queued)) {
      if (result.run) hook.release(result.run.key);
      return;
    }
    if (current.updatedAt !== revision) {
      if (result.run) hook.release(result.run.key);
      return this.runChecks(routineId, hold, manual);
    }
    const allocations: ResultsThreadAllocation[] = [];
    let run: RoutineRun | undefined;
    try {
      this.commitMutation(() => {
        applyCheckResult(current, result, this.now());
        if (result.run) {
          run = queued ?? this.newRun(current, this.now(), false, allocations);
          if (queued) Object.assign(run, routineRunDefinition(current), {
            timeoutMinutes: current.timeoutMinutes,
            resultsThreadId: resolveRoutineResultsThread(current, this.options.resolveResultsThread, allocations, this.now(), run.sourceThreadId),
          });
          if (run.timeoutMinutes === undefined) delete run.timeoutMinutes;
          Object.assign(run, { prompt: result.run.prompt, checkKey: result.run.key });
        } else if (queued && !result.trouble) {
          Object.assign(queued, { status: "completed", output: routineLine("routines.server.nothingNew"), outputCode: "routines.server.nothingNew", report: { state: "quiet" }, finishedAt: this.now() } satisfies Partial<RoutineRun>);
        }
      }, () => this.discardResultsThreads(allocations));
    } catch (error) {
      if (result.run) hook.release(result.run.key);
      return console.error(`routines: could not save the checks of ${routineId}`, error);
    }
    this.emitRoutine(current);
    if (queued && !result.run && result.trouble) this.failRun(queued, result.trouble);
    else if (run ?? queued) this.emitRun((run ?? queued)!);
    if (run) queueMicrotask(() => this.tickInBackground());
  }

  handleRuntimeEvent(event: RuntimeEvent): RoutineRun | null {
    const run = this.runs.find((r) => r.threadId === event.threadId && ["running", "waiting"].includes(r.status));
    if (event.type === "turn.completed") this.slowStops.confirmed(event.threadId); this.watch.seen(event.threadId);
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
      this.clock.work(run, this.now());
    } else if (event.type === "request.opened") {
      run.asked ??= askOf(event, this.now());
      this.wait(run, waitingFor(run.asked));
    } else if (event.type === "request.resolved") {
      const unanswered = settleAsk(run, event, this.now());
      if (unanswered) {
        void this.stopRun(run, unanswered, "stopped");
        return cloneRun(run);
      }
      this.clock.work(run, this.now());
    } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
      run.output = keptRunOutput(run.output, redactSecretsInText(event.text).trim(), 2_000);
    } else if (event.type === "runtime.error") {
      Object.assign(run, runLineFields("error", event.message, event.text));
      this.failureFacts.set(run.id, engineFacts(event));
    } else if (event.type === "turn.completed") {
      if (this.closing && (!event.ok || event.stopReason === "cancelled" || event.stopReason === "interrupted")) return null;
      if (event.cost != null) run.cost = (run.cost ?? 0) + event.cost;
      if (event.denials?.length) run.denials = [...new Set([...(run.denials ?? []), ...event.denials])];
      const facts = { ...this.failureFacts.get(run.id), stopReason: event.stopReason };
      // The bot's reply is no proof, so a failed step fails the run. Only one clear case completes it, partly done with the step kept in its error line: every failed call was blocked by the safety floor (it ran nothing) after the reply came back.
      const delivered = !event.ok && event.stopReason === "tool_error" && facts.partial === true && facts.blockedAfterReply === true && Boolean(run.output);
      if (!event.ok && !delivered) { this.settleFailure(run, routineFailure(run.error, event.stopReason), facts); return cloneRun(run); }
      this.failureFacts.delete(run.id);
      const waitsOnTeammates = this.options.hasPendingDelegations?.(event.threadId) === true, handoffRefused = waitsOnTeammates ? null : this.options.refusedHandoff?.(event.threadId);
      if (handoffRefused) { const said = typeof handoffRefused === "string" ? { text: handoffRefused } : handoffRefused; this.failRun(Object.assign(run, { partial: (said.partial !== false && Boolean(run.output)) || undefined }, said.lendingRefused ? { lendingRefused: true as const } : {}), said.text); queueMicrotask(() => this.tickInBackground()); return cloneRun(run); }
      if (waitsOnTeammates) this.wait(run, ROUTINE_HANDOFF_WAIT);
      else { Object.assign(run, { status: "completed", attention: undefined, finishedAt: this.now() } satisfies Partial<RoutineRun>, delivered ? { partial: true } : {}); this.ownerNotices = this.ownerNotices.filter((notice) => notice.botId !== run.botId); }
      if (!delivered) run.error = undefined;
    } else {
      return null;
    }
    if (event.type === "turn.completed") this.saveLater(); else this.progress.soon();
    this.emitRun(run);
    if (event.type === "turn.completed") queueMicrotask(() => this.tickInBackground());
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
    const held = facts.limit !== undefined || facts.limitResetsAt !== undefined ? facts.limit ?? "engine" : facts.stopReason === "auth_required" ? "signed-out" : undefined, backupReady = held !== undefined && this.options.limitBackup?.(run.botId, held) === true;
    const recovery = recoverRun(run, failure, { ...facts, ...(backupReady ? { backupReady } : {}), nextScheduled: nextScheduledRun(run, this.routines) }, this.now(), this.ownerNotices);
    if (!recovery.queued) this.failRun(Object.assign(run, { partial: (facts.partial && Boolean(run.output)) || undefined }), recovery.error, "failed", recovery.alert);
    else {
      this.saveLater();
      this.emitRun(run);
      if (recovery.alert) this.options.onRunDeferred?.(cloneRun(run), recovery.alert);
    }
    queueMicrotask(() => this.tickInBackground());
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
      this.saveLater();
      this.emitRun(run);
    } else {
      run.status = status === "stopped" ? "cancelled" : "completed";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = undefined;
      if (status !== "stopped") run.output = safeDetail.slice(0, 2_000) || undefined;
      this.saveLater();
      this.emitRun(run);
    }
    queueMicrotask(() => this.tickInBackground());
    return cloneRun(run);
  }

  /** Timed from when it began, so a later occurrence can tell a wait that went unanswered. */
  private wait(run: RoutineRun, attention: string | undefined) {
    if (run.status !== "waiting" || run.waitingSince === undefined) run.waitingSince = this.now();
    this.clock.rest(run, this.now()); Object.assign(run, { status: "waiting", attention } satisfies Partial<RoutineRun>);
  }

  private async stopRun(run: RoutineRun, detail: string, status: "stopped" | "limit-reached") {
    if (run.target === "room-goal") run.goalStatus = status;
    this.failRun(Object.assign(run, { partial: Boolean(run.output) || undefined }), detail);
    if (!run.threadId) return;
    if (run.target === "room-goal") await this.options.interruptGoal?.(run.groupId, run.threadId, { status, detail }).catch(() => {});
    else await this.options.interruptTurn?.(run.botId, run.threadId).catch(() => {});
  }

  private failRun(run: RoutineRun, message: string, status: "failed" | "missed" = "failed", alert?: RoutineAlert | null) {
    Object.assign(run, { status, attention: undefined, error: redactSecretsInText(message).slice(0, 500), finishedAt: this.now() } satisfies Partial<RoutineRun>);
    const routine = this.routines.find((candidate) => candidate.id === run.routineId), spaced = status === "failed" ? noStartAlert(routine, this.runs, run) ?? failureSpacingAlert(routine, this.runs, run) : undefined;
    this.saveLater(); this.emitRun(run);
    const repeat = !run.lendingRefused && (failsLikeLastOutcome(this.runs, run) || (run.checkKey !== undefined && outcomesNewestFirst(this.runs, run.routineId, run.id)[0]?.status === "failed"));
    this.options.onRunFailed?.(cloneRun(run), spaced ?? (alert === undefined && repeat ? null : alert));
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
      if (!this.options.goalState) return "missing";
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
    const resultsThreadId = resolveRoutineResultsThread(routine, this.options.resolveResultsThread, allocations, this.now(), sourceThreadId);
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: routine.id,
      ...routineRunDefinition(routine),
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
    this.timer?.poke(); this.options.emit?.({ kind: "routine", routine: this.routineWithHealth(routine) });
  }

  private emitRun(run: RoutineRun) {
    this.timer?.poke(); this.options.emit?.({ kind: "routine.run", run: cloneRun(run) });
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

  private matchingRoutineRequestReceipt(request: RoutineRequestCommit): RoutineRequestReceipt | null { return matchingRequestReceipt(this.routineRequestReceipts, request); }
  private rememberRoutineRequest(request: RoutineRequestCommit, resultId: string, appliedAt: number) { rememberRequest(this.routineRequestReceipts, request, resultId, appliedAt); }

  /** The row of a run whose stop did not finish in time says so, until the stop is confirmed. */
  private stopChanged(threadId: string, state: StopState) {
    const run = this.runs.findLast((candidate) => candidate.threadId === threadId);
    if (run && markStop(run, state)) { this.saveLater(); this.timer?.poke(); this.options.emit?.({ kind: "routine.run", run: cloneRun(run) }); }
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

  /** Lands at the end of the running save batch (server/save-batch.ts); what a caller rolls back on failure uses save. */ private saveLater() { saveSoon(this, () => this.save()); }
  private save() {
    if (this.unreadable) { this.progress.written(); return; }
    evictRuns(this.runs, MAX_RUNS); const recordOccurrences = this.ledger.observe(this.routines, this.runs);
    mkdirSync(dirname(this.file), { recursive: true });
    this.disk.write(JSON.stringify({
      version: 1,
      ...(this.frozenPending ? {} : { frozenResultsCleared: true }),
      routines: [...this.routines, ...this.unloadedRoutines],
      runs: this.runs,
      routineRequestReceipts: this.routineRequestReceipts,
      webhookRunReceipts: this.webhookRunReceipts,
      ...(this.startupLaunchId === undefined ? {} : { startupLaunchId: this.startupLaunchId }), ...(this.noStartOffsChecked ? { noStartOffsChecked: true } : {}),
      ...(this.ownerNotices.length ? { ownerNotices: this.ownerNotices } : {}),
      ...(this.holds.length ? { holds: this.holds } : {}),
    } satisfies RoutineFile));
    this.progress.written(); recordOccurrences();
  }
}
