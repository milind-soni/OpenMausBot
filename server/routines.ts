import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";

export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] }
  | {
      type: "interval";
      everyMinutes: number;
      from: string;
      to: string;
      weekdays: number[];
    };

/** `cloud` runs the agent itself inside the bot's Box VM. `maus` keeps
 * using the provider selected on the MAUS and only borrows its configured
 * computer tools, if any. */
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

/** Per-job restrictions can only remove capabilities from the assigned bot;
 * they never grant something the bot/engine does not already have. */
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

export interface RoutinePrefilter {
  type: "change-marker";
  sourceIds: string[];
}

export type RoutinePreflightDecision =
  | { kind: "run"; reason: string; marker?: string }
  | { kind: "skip"; reason: string; marker?: string };

/** A source marker is safe to compare when its collector can provide an
 * opaque deterministic fingerprint. Healthy sources fingerprint their
 * cursor; unavailable sources may use a bounded retry bucket. A reader sets
 * ready=false only when it genuinely cannot make a safe comparison. */
export interface RoutinePrefilterMarker {
  sourceId: string;
  marker: string | null;
  ready: boolean;
}

export type RoutinePrefilterMarkerReader = (
  botId: string,
  sourceIds: readonly string[],
) => RoutinePrefilterMarker[] | Promise<RoutinePrefilterMarker[]>;

/** Build the generic change-marker policy used by any scheduled routine. The
 * routine manager persists the returned marker; this function only decides
 * whether the current source snapshot is safe to compare. */
export function createChangeMarkerPreflight(
  readMarkers: RoutinePrefilterMarkerReader,
): (routine: Routine, run: RoutineRun, previousMarker?: string) => Promise<RoutinePreflightDecision> {
  return async (routine, _run, previousMarker) => {
    const prefilter = routine.prefilter;
    if (!prefilter || prefilter.type !== "change-marker") {
      return { kind: "run", reason: "No change-marker prefilter configured" };
    }
    const snapshots = await readMarkers(routine.botId, prefilter.sourceIds);
    if (snapshots.length !== prefilter.sourceIds.length || snapshots.some((snapshot) => !snapshot.ready || !snapshot.marker)) {
      return { kind: "run", reason: "Source markers are not all comparable" };
    }
    const marker = prefilter.sourceIds.map((sourceId) => {
      const snapshot = snapshots.find((candidate) => candidate.sourceId === sourceId);
      return `${sourceId}:${snapshot?.marker ?? ""}`;
    }).join("|");
    if (previousMarker === marker) return { kind: "skip", reason: "No source marker changed", marker };
    return { kind: "run", reason: "A source marker changed", marker };
  };
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
  /** When the durable work item closes, this routine is no longer relevant. */
  workLockId?: string;
  /** Zero or one. A retry is never an identical automatic replay: its caller
   * must supply the materially different strategy that will be attempted. */
  maxChangedStrategyRetries?: 0 | 1;
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
  durationMinutes?: number;
  botId: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  /** Why this receipt exists. Kept optional so version-1 files migrate in place. */
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
  /** Later interval slots folded into this receipt while the bot was busy. */
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

interface RoutineFile {
  version: 1;
  routines: Routine[];
  runs: RoutineRun[];
  prefilterMarkers?: Record<string, string>;
}

export interface RoutineManagerOptions {
  file?: string;
  now?: () => number;
  /** Keyed frames only: every payload on this bus is `{ kind, … }`, which
   * is what lets the server number and replay them. */
  emit?: (payload: Record<string, unknown>) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  createTask: (botId: string, title: string, activate?: boolean) => { threadId: string } | null;
  startTurn: (
    botId: string,
    threadId: string,
    prompt: string,
    runOn: RoutineRunOn,
    triggerSource: RoutineRunTrigger,
    capabilities: RoutineCapabilityPolicy | undefined,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  interruptTurn?: (botId: string, threadId: string, runOn: RoutineRunOn) => Promise<void>;
  onRunFailed?: (run: RoutineRun) => void;
  preflight?: (routine: Routine, run: RoutineRun, previousMarker?: string) => Promise<RoutinePreflightDecision>;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const CATCH_UP_MS = 12 * 60 * 60_000;
const MAX_RUNS = 2_000;

function cleanDays(days: unknown): number[] {
  if (!Array.isArray(days)) return ALL_DAYS;
  const out = [...new Set(days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return out.length ? out : ALL_DAYS;
}

function cleanSchedule(schedule: RoutineSchedule): RoutineSchedule {
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
    const everyMinutes = Math.round(Number(schedule.everyMinutes));
    const from = String(schedule.from ?? "");
    const to = String(schedule.to ?? "");
    if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 1_440) {
      throw new Error("Interval must be between 1 and 1440 minutes");
    }
    if (!isWallClock(from) || !isWallClock(to)) throw new Error("Time must use HH:MM");
    if (wallClockMinutes(from) > wallClockMinutes(to)) {
      throw new Error("Interval end time must be after its start time");
    }
    return { type: "interval", everyMinutes, from, to, weekdays: cleanDays(schedule.weekdays) };
  }
  throw new Error("Choose a supported schedule");
}

function isWallClock(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function wallClockMinutes(value: string): number {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function atWallClock(day: Date, value: string): Date {
  const result = new Date(day);
  const minutes = wallClockMinutes(value);
  result.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return result;
}

/** Next wall-clock occurrence in this computer's timezone, strictly after `after`. */
export function nextOccurrence(schedule: RoutineSchedule, after: number): number | null {
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.type === "interval") {
    const weekdays = new Set(cleanDays(schedule.weekdays));
    for (let offset = 0; offset <= 8; offset++) {
      const day = new Date(after);
      day.setDate(day.getDate() + offset);
      day.setHours(0, 0, 0, 0);
      if (!weekdays.has(day.getDay())) continue;
      const start = atWallClock(day, schedule.from);
      const end = atWallClock(day, schedule.to);
      for (let slot = start; slot.getTime() <= end.getTime(); ) {
        if (slot.getTime() > after) return slot.getTime();
        const next = new Date(slot);
        next.setMinutes(next.getMinutes() + schedule.everyMinutes);
        if (next.getTime() <= slot.getTime()) break;
        slot = next;
      }
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

function sanitizeInput(input: RoutineInput): Omit<Routine, "id" | "createdAt" | "updatedAt" | "nextRunAt"> {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const prompt = String(input.prompt ?? "").trim().slice(0, 20_000);
  const botId = String(input.botId ?? "").trim();
  if (!name) throw new Error("Give the routine a name");
  if (!prompt) throw new Error("Tell the bot what to do");
  if (!botId) throw new Error("Choose a bot");
  const runOn = input.runOn ?? "maus";
  if (runOn !== "maus" && runOn !== "cloud") throw new Error("Choose where this routine runs");
  const budget = cleanBudget(input.budget);
  const prefilter = cleanPrefilter(input.prefilter);
  const capabilities = cleanCapabilities(input.capabilities);
  const workLockId = input.workLockId?.trim().slice(0, 200) || undefined;
  const maxChangedStrategyRetries = input.maxChangedStrategyRetries === 1 ? 1 : 0;
  return {
    name,
    prompt,
    botId,
    runOn,
    enabled: input.enabled !== false,
    schedule: cleanSchedule(input.schedule),
    durationMinutes: Math.min(240, Math.max(15, Math.round(Number(input.durationMinutes) || 30))),
    ...(budget ? { budget } : {}),
    ...(prefilter ? { prefilter } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(workLockId ? { workLockId } : {}),
    ...(maxChangedStrategyRetries ? { maxChangedStrategyRetries } : {}),
  };
}

function cleanPositiveNumber(value: unknown, maximum: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Routine budget values must be positive numbers");
  return Math.min(maximum, parsed);
}

function cleanBudget(value: RoutineBudget | undefined): RoutineBudget | undefined {
  if (!value) return undefined;
  const maxScheduledRunsPerDay = cleanPositiveNumber(value.maxScheduledRunsPerDay, 10_000);
  const maxTokensPerDay = cleanPositiveNumber(value.maxTokensPerDay, 100_000_000);
  const maxCostUsdPerDay = cleanPositiveNumber(value.maxCostUsdPerDay, 100_000);
  if (maxScheduledRunsPerDay === undefined && maxTokensPerDay === undefined && maxCostUsdPerDay === undefined) {
    return undefined;
  }
  return {
    ...(maxScheduledRunsPerDay === undefined ? {} : { maxScheduledRunsPerDay: Math.floor(maxScheduledRunsPerDay) }),
    ...(maxTokensPerDay === undefined ? {} : { maxTokensPerDay: Math.floor(maxTokensPerDay) }),
    ...(maxCostUsdPerDay === undefined ? {} : { maxCostUsdPerDay }),
  };
}

function cleanPrefilter(value: RoutinePrefilter | undefined): RoutinePrefilter | undefined {
  if (!value) return undefined;
  if (value.type !== "change-marker") throw new Error("Choose a supported routine prefilter");
  const sourceIds = [...new Set(value.sourceIds.map((sourceId) => String(sourceId).trim()).filter(Boolean))].slice(0, 50);
  if (sourceIds.length === 0) throw new Error("A change-marker prefilter needs at least one source");
  return { type: "change-marker", sourceIds };
}

function cleanCapabilities(value: RoutineCapabilityPolicy | undefined): RoutineCapabilityPolicy | undefined {
  if (!value) return undefined;
  const connectedApps = value.connectedApps ?? "inherit";
  const computer = value.computer ?? "inherit";
  const peerBots = value.peerBots ?? "inherit";
  const phone = value.phone ?? "inherit";
  if (!["inherit", "off", "read-only", "draft-only", "execute"].includes(connectedApps)) {
    throw new Error("Choose a supported connected-apps capability policy");
  }
  if (!["inherit", "off", "read-only", "execute"].includes(computer)) {
    throw new Error("Choose a supported computer capability policy");
  }
  if (!["inherit", "off"].includes(peerBots) || !["inherit", "off"].includes(phone)) {
    throw new Error("Choose a supported task capability policy");
  }
  if (connectedApps === "inherit" && computer === "inherit" && peerBots === "inherit" && phone === "inherit") {
    return undefined;
  }
  return { connectedApps, computer, peerBots, phone };
}

export class RoutineManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: RoutineManagerOptions;
  private routines: Routine[] = [];
  private runs: RoutineRun[] = [];
  private prefilterMarkers = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: RoutineManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "routines.json");
    this.now = options.now ?? Date.now;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RoutineFile>;
      this.routines = Array.isArray(disk.routines)
        ? disk.routines.map((routine) => ({ ...routine, runOn: routine.runOn ?? "maus" }))
        : [];
      this.runs = Array.isArray(disk.runs)
        ? disk.runs.map((run) => ({ ...run, runOn: run.runOn ?? "maus" }))
        : [];
      this.prefilterMarkers = new Map(
        Object.entries(disk.prefilterMarkers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    } catch {
      this.routines = [];
      this.runs = [];
    }
    // A local process cannot still own these turns after a full restart.
    // Preserve them as recoverable blockers instead of calling interrupted
    // work a terminal failure; one explicitly changed strategy may resume it.
    const recovered: RoutineRun[] = [];
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "waiting") {
        run.status = "blocked";
        run.error = "OpenMausBot restarted while this routine was running";
        run.finishedAt = this.now();
        recovered.push({ ...run });
      }
    }
    if (recovered.length > 0) {
      this.save();
      for (const run of recovered) this.options.onRunFailed?.(run);
    }
  }

  listRoutines(): Routine[] {
    return this.routines.map((r) => ({ ...r, schedule: { ...r.schedule } }));
  }

  listRuns(from?: number, to?: number): RoutineRun[] {
    return this.runs
      .filter((r) => (from == null || r.scheduledFor >= from) && (to == null || r.scheduledFor <= to))
      .sort((a, b) => b.scheduledFor - a.scheduledFor)
      .map((r) => ({ ...r }));
  }

  activeRunForBot(botId: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.botId === botId && ["running", "waiting"].includes(candidate.status),
    );
    return run ? { ...run } : null;
  }

  isActiveThread(threadId: string): boolean {
    return this.runs.some(
      (run) => run.threadId === threadId && ["running", "waiting"].includes(run.status),
    );
  }

  create(input: RoutineInput): Routine {
    const clean = sanitizeInput(input);
    if (this.options.botState(clean.botId) === "missing") throw new Error("That bot no longer exists");
    const at = this.now();
    const routine: Routine = {
      id: randomUUID(),
      ...clean,
      nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, at) : null,
      createdAt: at,
      updatedAt: at,
    };
    this.routines.unshift(routine);
    this.save();
    this.emitRoutine(routine);
    return { ...routine, schedule: { ...routine.schedule } };
  }

  update(id: string, patch: Partial<RoutineInput>): Routine | null {
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    const clean = sanitizeInput({
      name: patch.name ?? routine.name,
      prompt: patch.prompt ?? routine.prompt,
      botId: patch.botId ?? routine.botId,
      runOn: patch.runOn ?? routine.runOn,
      enabled: patch.enabled ?? routine.enabled,
      schedule: patch.schedule ?? routine.schedule,
      durationMinutes: patch.durationMinutes ?? routine.durationMinutes,
      budget: patch.budget ?? routine.budget,
      prefilter: patch.prefilter ?? routine.prefilter,
      capabilities: patch.capabilities ?? routine.capabilities,
      workLockId: patch.workLockId ?? routine.workLockId,
      maxChangedStrategyRetries: patch.maxChangedStrategyRetries ?? routine.maxChangedStrategyRetries,
    });
    if (this.options.botState(clean.botId) === "missing") throw new Error("That bot no longer exists");
    Object.assign(routine, clean, {
      nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, this.now()) : null,
      updatedAt: this.now(),
    });
    if (Object.prototype.hasOwnProperty.call(patch, "prefilter")) {
      this.prefilterMarkers.delete(routine.id);
    }
    // Optional fields need an explicit clear path for package migrations and
    // the editor's `{}` budget shape. `Object.assign` cannot remove a stale
    // persisted field when sanitizeInput omits an undefined value.
    if (Object.prototype.hasOwnProperty.call(patch, "budget") && clean.budget === undefined) delete routine.budget;
    if (Object.prototype.hasOwnProperty.call(patch, "prefilter") && clean.prefilter === undefined) delete routine.prefilter;
    if (Object.prototype.hasOwnProperty.call(patch, "capabilities") && clean.capabilities === undefined) delete routine.capabilities;
    if (Object.prototype.hasOwnProperty.call(patch, "workLockId") && clean.workLockId === undefined) delete routine.workLockId;
    if (Object.prototype.hasOwnProperty.call(patch, "maxChangedStrategyRetries") && clean.maxChangedStrategyRetries === undefined) {
      delete routine.maxChangedStrategyRetries;
    }
    if (patch.enabled === false) {
      for (const run of this.runs) {
        if (run.routineId !== routine.id || run.status !== "queued") continue;
        run.status = "cancelled";
        run.finishedAt = this.now();
        run.error = "The routine was paused before this run started";
        this.emitRun(run);
      }
    }
    this.save();
    this.emitRoutine(routine);
    return { ...routine, schedule: { ...routine.schedule } };
  }

  remove(id: string): boolean {
    const at = this.routines.findIndex((r) => r.id === id);
    if (at === -1) return false;
    this.routines.splice(at, 1);
    this.prefilterMarkers.delete(id);
    for (const run of this.runs) {
      if (run.routineId === id && run.status === "queued") {
        run.status = "cancelled";
        run.finishedAt = this.now();
        this.emitRun(run);
      }
    }
    this.save();
    this.options.emit?.({ kind: "routine.deleted", routineId: id });
    return true;
  }

  disableForBot(botId: string) {
    let changed = false;
    for (const routine of this.routines) {
      if (routine.botId !== botId || !routine.enabled) continue;
      routine.enabled = false;
      routine.nextRunAt = null;
      routine.updatedAt = this.now();
      this.emitRoutine(routine);
      changed = true;
    }
    for (const run of this.runs) {
      if (run.botId !== botId || !["queued", "running", "waiting"].includes(run.status)) continue;
      run.status = "cancelled";
      run.finishedAt = this.now();
      run.error = "The assigned bot was deleted";
      this.emitRun(run);
      if (run.threadId) void this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "maus").catch(() => {});
      changed = true;
    }
    if (changed) this.save();
  }

  /** Disable only legacy cadence definitions selected by an integration
   * after its replacement has successfully started. This intentionally does
   * not touch queued/running work or unrelated routines for the same bot. */
  disableMatching(predicate: (routine: Routine) => boolean): number {
    let disabled = 0;
    for (const routine of this.routines) {
      if (!routine.enabled || !predicate(routine)) continue;
      routine.enabled = false;
      routine.nextRunAt = null;
      routine.updatedAt = this.now();
      this.emitRoutine(routine);
      disabled += 1;
    }
    if (disabled > 0) this.save();
    return disabled;
  }

  /** Close the calendar guard when the work it protects is already done. The
   * caller supplies only a durable lock id; names and prompts are irrelevant. */
  cancelForWorkLock(workLockId: string, reason = "The related work was closed"): boolean {
    const cleanId = workLockId.trim();
    if (!cleanId) return false;
    const routineIds = new Set<string>();
    let changed = false;
    for (const routine of this.routines) {
      if (routine.workLockId !== cleanId) continue;
      routineIds.add(routine.id);
      if (!routine.enabled && routine.nextRunAt === null) continue;
      routine.enabled = false;
      routine.nextRunAt = null;
      routine.updatedAt = this.now();
      this.emitRoutine(routine);
      changed = true;
    }
    for (const run of this.runs) {
      if (!routineIds.has(run.routineId) || !["queued", "running", "waiting"].includes(run.status)) continue;
      run.status = "cancelled";
      run.finishedAt = this.now();
      run.error = reason.slice(0, 500);
      this.emitRun(run);
      if (run.threadId) void this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "maus").catch(() => {});
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  runNow(id: string): RoutineRun | null {
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    const run = this.newRun(routine, this.now(), true);
    this.save();
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return { ...run };
  }

  /** Queue an event-driven job without inventing a calendar schedule. Webhook
   * definitions live in their own store; the execution receipt deliberately
   * reuses this manager so busy-bot ordering, task creation and VM routing stay
   * identical for every unattended job. */
  enqueueWebhook(input: {
    webhookId: string;
    webhookName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
  }): RoutineRun {
    if (this.options.botState(input.botId) === "missing") {
      throw Object.assign(new Error("The assigned MAUS no longer exists"), { status: 410 });
    }
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: input.webhookId,
      routineName: input.webhookName,
      prompt: input.prompt,
      botId: input.botId,
      runOn: input.runOn,
      scheduledFor: input.receivedAt,
      status: "queued",
      manual: false,
      triggerSource: "webhook",
      webhookId: input.webhookId,
      deliveryId: input.deliveryId,
      createdAt: this.now(),
    };
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) this.runs.splice(0, this.runs.length - MAX_RUNS);
    this.save();
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return { ...run };
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
      run.finishedAt = this.now();
      run.error = message.slice(0, 500);
      this.emitRun(run);
      changed = true;
    }
    if (changed) this.save();
  }

  async cancelRun(id: string): Promise<RoutineRun | null> {
    const run = this.runs.find((r) => r.id === id);
    if (!run || !["queued", "running", "waiting", "blocked"].includes(run.status)) return null;
    run.status = "cancelled";
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
    if (run.threadId) await this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "maus").catch(() => {});
    queueMicrotask(() => void this.tick());
    return { ...run };
  }

  /** Attach verification evidence to the exact detached task that produced
   * it. A successful tool call is not evidence by itself: the agent must name
   * the independently checkable test, artifact, source, screen, or receipt. */
  recordEvidence(
    botId: string,
    threadId: string,
    input: { kind: RoutineEvidence["kind"]; summary: string; reference?: string },
  ): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.botId === botId && candidate.threadId === threadId && ["running", "waiting"].includes(candidate.status),
    );
    if (!run) return null;
    const summary = String(input.summary ?? "").trim().slice(0, 500);
    if (!summary) throw new Error("Evidence needs a concrete summary");
    const reference = typeof input.reference === "string" ? input.reference.trim().slice(0, 2_000) : "";
    const evidence: RoutineEvidence = {
      id: randomUUID(),
      kind: input.kind,
      summary,
      ...(reference ? { reference } : {}),
      recordedAt: this.now(),
    };
    run.evidence = [...(run.evidence ?? []), evidence].slice(-50);
    this.save();
    this.emitRun(run);
    return { ...run, evidence: run.evidence.map((item) => ({ ...item })) };
  }

  /** Queue the one permitted recovery attempt. The changed strategy is a
   * required, durable part of the receipt; replaying the same plan is refused. */
  retryRun(id: string, strategy: string): RoutineRun {
    const prior = this.runs.find((candidate) => candidate.id === id);
    if (!prior) throw Object.assign(new Error("No such run"), { status: 404 });
    if (!["blocked", "failed"].includes(prior.status)) {
      throw Object.assign(new Error("Only blocked or failed work can be retried"), { status: 409 });
    }
    const cleanStrategy = String(strategy ?? "").trim().slice(0, 1_000);
    if (cleanStrategy.length < 12) {
      throw Object.assign(new Error("Describe a materially different retry strategy"), { status: 400 });
    }
    const limit = prior.maxChangedStrategyRetries ?? 0;
    const retryCount = prior.retryCount ?? 0;
    if (limit < 1 || retryCount >= limit) {
      throw Object.assign(new Error("This run has no changed-strategy retry remaining"), { status: 409 });
    }
    if (prior.strategy?.trim().toLowerCase() === cleanStrategy.toLowerCase()) {
      throw Object.assign(new Error("The retry strategy must differ from the previous strategy"), { status: 409 });
    }
    const basePrompt = prior.prompt ?? this.routines.find((routine) => routine.id === prior.routineId)?.prompt;
    if (!basePrompt) throw Object.assign(new Error("The original instructions are no longer available"), { status: 409 });
    const retry: RoutineRun = {
      id: randomUUID(),
      routineId: prior.routineId,
      routineName: prior.routineName,
      prompt: `${basePrompt}\n\n[CHANGED-STRATEGY RECOVERY]\nThe previous attempt was blocked or failed: ${prior.error ?? prior.blocker ?? "unknown reason"}.\nUse this materially different strategy: ${cleanStrategy}\nDo not repeat the failed approach. If this strategy cannot proceed, return a precise blocker and stop.\n[/CHANGED-STRATEGY RECOVERY]`,
      durationMinutes: prior.durationMinutes,
      botId: prior.botId,
      runOn: prior.runOn,
      scheduledFor: this.now(),
      status: "queued",
      manual: prior.manual,
      triggerSource: prior.triggerSource,
      ...(prior.webhookId ? { webhookId: prior.webhookId } : {}),
      ...(prior.deliveryId ? { deliveryId: prior.deliveryId } : {}),
      ...(prior.capabilities ? { capabilities: { ...prior.capabilities } } : {}),
      ...(prior.workLockId ? { workLockId: prior.workLockId } : {}),
      maxChangedStrategyRetries: limit,
      retryOf: prior.id,
      retryCount: retryCount + 1,
      strategy: cleanStrategy,
      createdAt: this.now(),
    };
    this.runs.push(retry);
    if (this.runs.length > MAX_RUNS) this.runs.splice(0, this.runs.length - MAX_RUNS);
    this.save();
    this.emitRun(retry);
    queueMicrotask(() => void this.tick());
    return { ...retry };
  }

  markSeen(id: string): RoutineRun | null {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return null;
    if (!run.seenAt) {
      run.seenAt = this.now();
      this.save();
      this.emitRun(run);
    }
    return { ...run };
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      let changed = false;
      for (const routine of this.routines) {
        if (!routine.enabled || routine.nextRunAt == null || routine.nextRunAt > now) continue;
        const scheduledFor = routine.nextRunAt;
        const late = now - scheduledFor;
        if (late > CATCH_UP_MS) {
          const missed = this.newRun(routine, scheduledFor, false);
          missed.status = "missed";
          missed.finishedAt = now;
          missed.error = "This computer was offline for more than 12 hours after the scheduled time";
          this.emitRun(missed);
        } else {
          const queued = this.runs.find(
            (candidate) => candidate.routineId === routine.id && candidate.status === "queued",
          );
          if (routine.schedule.type === "interval" && queued) {
            queued.coalescedThrough = scheduledFor;
            queued.coalescedCount = (queued.coalescedCount ?? 0) + 1;
            this.emitRun(queued);
          } else {
            const run = this.newRun(routine, scheduledFor, false);
            this.emitRun(run);
          }
        }
        routine.nextRunAt =
          routine.schedule.type === "once" ? null : nextOccurrence(routine.schedule, Math.max(now, scheduledFor));
        if (routine.schedule.type === "once") routine.enabled = false;
        routine.updatedAt = now;
        this.emitRoutine(routine);
        changed = true;
      }
      if (changed) this.save();

      for (const run of this.runs) {
        if (!["running", "waiting"].includes(run.status) || run.startedAt === undefined || run.durationMinutes === undefined) continue;
        if (now - run.startedAt <= run.durationMinutes * 60_000) continue;
        const threadId = run.threadId;
        this.blockRun(run, `Routine exceeded its ${run.durationMinutes}-minute runtime limit`);
        if (threadId) void this.options.interruptTurn?.(run.botId, threadId, run.runOn).catch(() => {});
      }

      for (const run of [...this.runs].reverse()) {
        if (run.status !== "queued") continue;
        const activeForBot = this.runs.some(
          (candidate) => candidate.id !== run.id
            && candidate.botId === run.botId
            && ["running", "waiting"].includes(candidate.status),
        );
        if (activeForBot) continue;
        const state = this.options.botState(run.botId);
        if (state === "busy") continue;
        if (state === "missing") {
          this.failRun(run, "The assigned bot no longer exists");
          continue;
        }
        const routine = this.routines.find((candidate) => candidate.id === run.routineId);
        if (!run.manual && run.triggerSource !== "webhook" && routine) {
          const budgetReason = this.budgetBlockReason(routine, run);
          if (budgetReason) {
            this.skipRun(run, budgetReason);
            continue;
          }
          if (routine.prefilter && this.options.preflight) {
            try {
              const decision = await this.options.preflight(routine, { ...run }, this.prefilterMarkers.get(routine.id));
              if (decision.marker && decision.marker !== this.prefilterMarkers.get(routine.id)) {
                this.prefilterMarkers.set(routine.id, decision.marker);
                this.save();
              }
              if (decision.kind === "skip") {
                this.skipRun(run, decision.reason);
                continue;
              }
            } catch {
              // Fail open: missing or broken evidence is not proof that a source is quiet.
            }
          }
        }
        // A webhook is an incoming message, so make its task the bot's live
        // chat immediately. Scheduled work remains detached and unobtrusive.
        const task = this.options.createTask(run.botId, run.routineName, run.triggerSource === "webhook");
        if (!task) {
          this.failRun(run, "Could not create a task for this run");
          continue;
        }
        run.threadId = task.threadId;
        run.startedAt = this.now();
        run.status = "running";
        this.save();
        this.emitRun(run);
        try {
          const prompt = this.promptForRun(run);
          if (!prompt) {
            this.failThread(task.threadId, "The routine was deleted before it could start");
            continue;
          }
          const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
          await this.options.startTurn(
            run.botId,
            task.threadId,
            prompt,
            run.runOn ?? "maus",
            triggerSource,
            run.capabilities,
            (message) => this.failThread(task.threadId, message),
          );
        } catch (error) {
          this.failThread(task.threadId, error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  handleRuntimeEvent(event: RuntimeEvent): RoutineRun | null {
    const run = this.runs.find((r) => r.threadId === event.threadId && ["running", "waiting"].includes(r.status));
    if (!run) return null;
    if (event.type === "request.opened") {
      run.status = "waiting";
    } else if (event.type === "request.resolved") {
      run.status = "running";
    } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
      run.output = event.text.trim().slice(0, 2_000);
    } else if (event.type === "runtime.error") {
      run.error = event.message.slice(0, 500);
      if (event.setup) run.blocker = run.error;
    } else if (event.type === "turn.retrying") {
      // the driver will relaunch this same run; a transient blip is not a
      // receipt-worthy failure, so keep the run running and stay quiet
      return null;
    } else if (event.type === "turn.completed") {
      run.cost = event.cost;
      run.usage = event.usage;
      run.denials = event.denials;
      if (!event.ok) {
        const reason = event.stopReason ?? run.blocker ?? run.error ?? "The bot did not complete this run";
        if (run.blocker || event.denials?.length) this.blockRun(run, reason);
        else this.failRun(run, reason);
        queueMicrotask(() => void this.tick());
        return { ...run };
      }
      run.status = run.evidence?.length ? "verified" : "completed";
      run.finishedAt = this.now();
      run.error = undefined;
      run.blocker = undefined;
    } else {
      return null;
    }
    this.save();
    this.emitRun(run);
    if (event.type === "turn.completed") queueMicrotask(() => void this.tick());
    return { ...run };
  }

  failThread(threadId: string, message: string) {
    const run = this.runs.find((r) => r.threadId === threadId && ["running", "waiting"].includes(r.status));
    if (!run) return;
    this.failRun(run, message);
    queueMicrotask(() => void this.tick());
  }

  private failRun(run: RoutineRun, message: string) {
    run.status = "failed";
    run.error = message.slice(0, 500);
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
    this.options.onRunFailed?.({ ...run });
  }

  private initialOccurrence(schedule: RoutineSchedule, now: number): number | null {
    if (schedule.type === "once") return Math.max(schedule.at, now);
    return nextOccurrence(schedule, now);
  }

  private blockRun(run: RoutineRun, message: string) {
    run.status = "blocked";
    run.blocker = message.slice(0, 500);
    run.error = run.blocker;
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
    this.options.onRunFailed?.({ ...run });
  }

  private skipRun(run: RoutineRun, reason: string) {
    run.status = "skipped";
    run.error = reason.slice(0, 500);
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
  }

  private budgetBlockReason(routine: Routine, queued: RoutineRun): string | null {
    const budget = routine.budget;
    if (!budget) return null;
    const dayStart = new Date(queued.scheduledFor);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const runs = this.runs.filter((run) =>
      run.id !== queued.id
      && run.routineId === routine.id
      && !run.manual
      && run.scheduledFor >= dayStart.getTime()
      && run.scheduledFor < dayEnd.getTime()
      && !["cancelled", "missed", "skipped"].includes(run.status));
    if (budget.maxScheduledRunsPerDay !== undefined && runs.length >= budget.maxScheduledRunsPerDay) {
      return `Daily scheduled-run budget reached (${budget.maxScheduledRunsPerDay})`;
    }
    const tokens = runs.reduce((sum, run) => sum + (run.usage?.input ?? 0) + (run.usage?.output ?? 0), 0);
    if (budget.maxTokensPerDay !== undefined && tokens >= budget.maxTokensPerDay) {
      return `Daily token budget reached (${budget.maxTokensPerDay})`;
    }
    const cost = runs.reduce((sum, run) => sum + (run.cost ?? 0), 0);
    if (budget.maxCostUsdPerDay !== undefined && cost >= budget.maxCostUsdPerDay) {
      return `Daily cost budget reached ($${budget.maxCostUsdPerDay})`;
    }
    return null;
  }

  private promptForRun(run: RoutineRun): string | undefined {
    const prompt = run.prompt ?? this.routines.find((routine) => routine.id === run.routineId)?.prompt;
    if (!prompt) return undefined;
    const contract = [
      "[OPENMAUS EXECUTION RECEIPT]",
      "Define success and non-success before acting. Treat a tool invocation as an attempt, never as proof of completion.",
      "When you have independently checkable evidence, call record_task_evidence with the test, artifact, source, screen, or receipt. If that tool is unavailable, state the evidence in the final response; the receipt will remain completed but unverified.",
      "If blocked, name the exact blocker and stop. Do not loop or silently repeat the same strategy.",
      "[/OPENMAUS EXECUTION RECEIPT]",
    ].join("\n");
    if (!run.coalescedThrough || !run.coalescedCount) return `${contract}\n\n${prompt}`;
    const context = [
      "[OPENMAUS ROUTINE WINDOW]",
      `Scheduled from: ${new Date(run.scheduledFor).toISOString()}`,
      `Coalesced through: ${new Date(run.coalescedThrough).toISOString()}`,
      `Additional due slots: ${run.coalescedCount}`,
      "Use durable source cursors to catch up the entire window; do not process only the latest slot.",
      "[/OPENMAUS ROUTINE WINDOW]",
    ].join("\n");
    return `${contract}\n\n${context}\n\n${prompt}`;
  }

  private newRun(routine: Routine, scheduledFor: number, manual: boolean): RoutineRun {
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: routine.id,
      routineName: routine.name,
      prompt: routine.prompt,
      durationMinutes: routine.durationMinutes,
      botId: routine.botId,
      runOn: routine.runOn ?? "maus",
      scheduledFor,
      status: "queued",
      manual,
      triggerSource: manual ? "manual" : "schedule",
      ...(routine.capabilities ? { capabilities: { ...routine.capabilities } } : {}),
      ...(routine.workLockId ? { workLockId: routine.workLockId } : {}),
      ...(routine.maxChangedStrategyRetries ? { maxChangedStrategyRetries: routine.maxChangedStrategyRetries } : {}),
      createdAt: this.now(),
    };
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) this.runs.splice(0, this.runs.length - MAX_RUNS);
    return run;
  }

  private emitRoutine(routine: Routine) {
    this.options.emit?.({ kind: "routine", routine: { ...routine, schedule: { ...routine.schedule } } });
  }

  private emitRun(run: RoutineRun) {
    this.options.emit?.({ kind: "routine.run", run: { ...run } });
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    const prefilterMarkers = Object.fromEntries(this.prefilterMarkers.entries());
    writeFileSync(temp, JSON.stringify({
      version: 1,
      routines: this.routines,
      runs: this.runs,
      ...(Object.keys(prefilterMarkers).length > 0 ? { prefilterMarkers } : {}),
    } satisfies RoutineFile, null, 2));
    renameSync(temp, this.file);
  }
}
