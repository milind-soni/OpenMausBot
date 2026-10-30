import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { cronScheduleLabel } from "../shared/cron-label.ts";
import { plainClock, plainTimeZone, plainWeekdays } from "../shared/plain-time-zone.ts";
import { normalizeCronSchedule, nextCronRuns } from "../shared/routine-schedule.ts";
import { newId } from "./contracts.ts";
import { UNDO_STALE, type DirectApply, type DirectApplyCheck } from "./direct-apply.ts";
import { redactSecretsInText } from "./redact.ts";
import { parseJson, schemaIssue, type JsonObject, type JsonValue } from "./schema.ts";
import {
  ENGINE_ID, intervalWindowMinutes, jsonObjectSchema, MAX_DATE_MS, ROUTINE_ID, routineProposalSchema, routineRequestCardDataSchema, storedScheduleSchema,
  storedSnapshotSchema, storedUndoSchema, TIME, type ParsedRoutineProposal, type RoutineToolChangesInput, type RoutineToolDefinitionInput,
  type RoutineToolScheduleInput,
} from "./routine-request-schemas.ts";
import { runsOnce } from "../shared/limit-reset.ts";
import { limitResetOccurrence } from "./routine-schedules.ts";
import {
  intervalHasRestrictions,
  nextOccurrence,
  type Routine,
  type RoutineInput,
  type RoutineManager,
  type RoutineRequestCommit,
  type RoutineSchedule,
  type RoutineScheduleInput,
} from "./routines.ts";
import type {
  RoutineRequestCardData,
  RoutineRequestChanges,
  RoutineRequestDefinition,
  RoutineRequestOperation,
  RoutineRequestRunOn,
  RoutineRequestSchedule,
  RoutineRequestScheduleChanges,
  RoutineRequestSnapshot,
  RoutineRequestUndo,
} from "../shared/routine-request.ts";

const WEEKDAY_NUMBER = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const;

const RFC3339_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/i;
const ACTION_COPY = {
  create: { title: "Schedule", detail: "Create routine" },
  update: { title: "Update", detail: "Update routine" },
  pause: { title: "Pause", detail: "Pause routine" },
  resume: { title: "Resume", detail: "Resume routine" },
  run_now: { title: "Run now", detail: "Run routine now" },
  delete: { title: "Delete", detail: "Delete routine" },
} as const satisfies Record<RoutineRequestOperation["action"], { title: string; detail: string }>;
const ROUTINE_REQUEST_FINGERPRINT_VERSION = 1 as const;

export type { RoutineProposalInput, RoutineToolChangesInput, RoutineToolDefinitionInput, RoutineToolScheduleInput } from "./routine-request-schemas.ts";

export interface RoutineRequestOptionCard {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  expired?: boolean;
  requestId?: string;
  tool?: string;
  held?: string;
  autoApplied?: boolean;
  undone?: boolean;
  routineRequest?: RoutineRequestCardData;
}

export interface RoutineRequestMessage {
  id: string;
  card?: RoutineRequestOptionCard;
}

export interface RoutineRequestStore {
  messagesFor(threadId: string): RoutineRequestMessage[];
  appendMessage(
    threadId: string,
    message: {
      role: "bot";
      kind: "options";
      card: RoutineRequestOptionCard;
      from?: { botId: string; name: string; color: string };
    },
  ): RoutineRequestMessage;
  patchMessage(
    threadId: string,
    messageId: string,
    patch: { card: RoutineRequestOptionCard },
  ): RoutineRequestMessage | null;
}

export interface RoutineRequestServiceOptions {
  store: RoutineRequestStore;
  routines: RoutineManager;
  now?: () => number;
  timeZone?: () => string;
  /** Server-owned, never request input. */
  autoApply?: DirectApplyCheck;
  cloudReady?: (botId: string) => Promise<{ ready: boolean; reason?: string }>;
  /** Revalidates ownership and capacity synchronously right before the card append, closing races across the cloud probe. */
  canPersist?: (
    botId: string,
    threadId: string,
    opensCard: boolean,
  ) => { ok: true } | { ok: false; status: number; error: string };
  /** Re-authorizes a cross-bot target at propose and confirm time: the card can outlive the target's section. */
  validateTarget?: (proposerBotId: string, target: { botId: string; name: string }) => string | null;
  engines?: LimitResetEngines;
}

export interface ProposeRoutineRequestArgs {
  botId: string;
  threadId: string;
  /** Untrusted model output; normalized by routineProposalSchema in propose(). */
  proposal: unknown;
  from?: { botId: string; name: string; color: string };
  /** Caller/turn lease, checked synchronously right before the durable card append. */
  canCommit?: () => boolean;
}

export interface RoutineProposalResult {
  requestId: string;
  messageId: string;
  title: string;
  summary: string;
  detail: string;
  nextRunAt: number | null;
  timeZone: string;
}

interface RoutineCardCopy {
  title: string;
  summary: string;
  detail: string;
  nextRunAt: number | null;
  tool: "schedule_routine" | "manage_routine";
}

export type ResolveRoutineRequestResult =
  | { claimed: false; state: "not_found" }
  | { claimed: true; state: "invalid"; error: string; status: number }
  | { claimed: true; state: "already_settled"; behavior: string }
  | { claimed: true; state: "denied" }
  | {
      claimed: true;
      state: "applied";
      action: RoutineRequestOperation["action"];
      resultId: string;
      settlementPending?: true;
      message?: string;
    };

export type UndoRoutineRequestResult =
  | { claimed: false }
  | { claimed: true; state: "already_undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true }
  | {
      claimed: true;
      state: "undone";
      action: RoutineRequestOperation["action"];
      routineId: string;
      restoredId?: string;
      ownersBefore?: boolean;
    };

export class RoutineRequestError extends Error {
  readonly status: number;
  readonly terminal: boolean;

  constructor(message: string, status = 400, options?: { terminal?: boolean }) {
    super(message);
    this.name = "RoutineRequestError";
    this.status = status;
    this.terminal = options?.terminal === true;
  }
}

function text(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new RoutineRequestError(`${field} is required`);
  if (trimmed.length > max) throw new RoutineRequestError(`${field} must be ${max.toLocaleString("en-US")} characters or fewer`);
  // Hidden under the visible card fields, where the store's shallow card redaction cannot reach.
  const redacted = redactSecretsInText(trimmed);
  if (redacted.length > max) {
    throw new RoutineRequestError(
      `${field} must remain ${max.toLocaleString("en-US")} characters or fewer after credentials are removed`,
    );
  }
  return redacted;
}

function runOn(value: RoutineRequestRunOn | undefined): RoutineRequestRunOn {
  return value ?? "maus";
}

function duration(value: number | undefined): number {
  const normalized = value ?? 30;
  if (!Number.isInteger(normalized) || normalized < 5 || normalized > 240) {
    throw new RoutineRequestError("durationMinutes must be a whole number from 5 to 240");
  }
  return normalized;
}

function timeout(value: number | null | undefined): number | null | undefined {
  if (value == null) return value;
  if (!Number.isInteger(value) || value < 5 || value > 240) {
    throw new RoutineRequestError("timeoutMinutes must be a whole number from 5 to 240");
  }
  return value;
}

function intervalWeekdays(values: string[]): number[] {
  const weekdays = values.map((day) => {
    const number = WEEKDAY_NUMBER[day.toLowerCase() as keyof typeof WEEKDAY_NUMBER];
    if (number === undefined) throw new RoutineRequestError(`Unsupported weekday: ${day}`);
    return number;
  });
  return [...new Set(weekdays)].sort();
}

function intervalWindow(
  value: { start: string; end: string },
  everyMinutes: number,
): { start: string; end: string } {
  if (!TIME.test(value.start) || !TIME.test(value.end)) {
    throw new RoutineRequestError("Interval windows must use 24-hour HH:MM");
  }
  if (value.start >= value.end) {
    throw new RoutineRequestError("Interval windows must end later on the same day");
  }
  if (intervalWindowMinutes(value) < everyMinutes) {
    throw new RoutineRequestError("The interval window must be at least as long as everyMinutes");
  }
  return { start: value.start, end: value.end };
}

function rfc3339Instant(value: string, offsetMessage: string): number {
  const parts = RFC3339_WITH_OFFSET.exec(value);
  if (!parts) throw new RoutineRequestError(offsetMessage);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const offsetHour = Number(parts[7] ?? 0);
  const offsetMinute = Number(parts[8] ?? 0);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new RoutineRequestError("Choose a valid RFC3339 date and time");
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new RoutineRequestError("Choose a valid RFC3339 date and time");
  return at;
}

function normalizeSchedule(schedule: RoutineToolScheduleInput, now: number, ownEngine?: string): RoutineRequestSchedule {
  if (schedule.type === "cron") {
    try {
      return normalizeCronSchedule(schedule, now);
    } catch (error) {
      throw new RoutineRequestError(error instanceof Error ? error.message : "Invalid cron schedule");
    }
  }
  if (schedule.type === "limit_reset") {
    const engine = (schedule.engine ?? ownEngine ?? "").trim();
    if (!ENGINE_ID.test(engine)) throw new RoutineRequestError("engine must be an engine id such as claude or codex");
    return { type: "limit_reset", engine, repeat: schedule.repeat ?? "once" };
  }
  if (schedule.type === "once") {
    const at = rfc3339Instant(
      schedule.at,
      "One-time schedules need an RFC3339 date-time with an explicit timezone offset",
    );
    if (at <= now) throw new RoutineRequestError("The scheduled date and time must be in the future");
    return { type: "once", at };
  }
  if (schedule.type === "interval") {
    if (!Number.isInteger(schedule.everyMinutes) || schedule.everyMinutes < 5 || schedule.everyMinutes > 1_440) {
      throw new RoutineRequestError("everyMinutes must be a whole number from 5 to 1440");
    }
    let anchorAt: number | undefined;
    if (schedule.anchorAt !== undefined) {
      anchorAt = rfc3339Instant(
        schedule.anchorAt,
        "Interval starts need an RFC3339 date-time with an explicit timezone offset",
      );
      if (!Number.isSafeInteger(anchorAt) || anchorAt < 0 || anchorAt > MAX_DATE_MS) {
        throw new RoutineRequestError("Choose a valid interval start time");
      }
    }
    let endsAt: number | undefined;
    if (schedule.endsAt !== undefined && schedule.endsAt !== null) {
      endsAt = rfc3339Instant(
        schedule.endsAt,
        "Interval ends need an RFC3339 date-time with an explicit timezone offset",
      );
      if (!Number.isSafeInteger(endsAt) || endsAt < 0 || endsAt > MAX_DATE_MS) {
        throw new RoutineRequestError("Choose a valid interval end time");
      }
      if (endsAt < (anchorAt ?? now)) {
        throw new RoutineRequestError("The interval end must not be before its start");
      }
    }
    return {
      type: "interval",
      everyMinutes: schedule.everyMinutes,
      ...(anchorAt === undefined ? {} : { anchorAt }),
      ...(schedule.weekdays == null ? {} : { weekdays: intervalWeekdays(schedule.weekdays) }),
      ...(schedule.window == null ? {} : { window: intervalWindow(schedule.window, schedule.everyMinutes) }),
      ...(endsAt === undefined ? {} : { endsAt }),
    };
  }
  if (!TIME.test(schedule.time)) {
    throw new RoutineRequestError("Weekly schedule time must use 24-hour HH:MM");
  }
  if (schedule.weekdays.length === 0) throw new RoutineRequestError("Choose at least one weekday");
  const weekdays = schedule.weekdays.map((day) => {
    // SAFETY: WEEKDAY_NUMBER keys are lower-case, and membership is checked just below.
    const number = WEEKDAY_NUMBER[day.toLowerCase() as keyof typeof WEEKDAY_NUMBER];
    if (number === undefined) throw new RoutineRequestError(`Unsupported weekday: ${day}`);
    return number;
  });
  return { type: "daily", time: schedule.time, weekdays: [...new Set(weekdays)].sort() };
}

function normalizeScheduleChanges(
  schedule: RoutineToolScheduleInput,
  now: number,
  ownEngine?: string,
): RoutineRequestScheduleChanges {
  const normalized = normalizeSchedule(schedule, now, ownEngine);
  if (schedule.type !== "interval" || normalized.type !== "interval") return normalized;
  return {
    ...normalized,
    ...(schedule.weekdays === null ? { weekdays: null } : {}),
    ...(schedule.window === null ? { window: null } : {}),
    ...(schedule.endsAt === null ? { endsAt: null } : {}),
  };
}

function normalizeDefinition(input: RoutineToolDefinitionInput, now: number, ownEngine?: string): RoutineRequestDefinition {
  const timeoutMinutes = timeout(input.timeoutMinutes);
  return {
    name: text(input.name, "name", 80),
    instructions: text(input.instructions, "instructions", 20_000),
    schedule: normalizeSchedule(input.schedule, now, ownEngine),
    runOn: runOn(input.runOn),
    durationMinutes: duration(input.durationMinutes),
    ...(timeoutMinutes == null ? {} : { timeoutMinutes }),
    ...(input.continuity === true ? { continuity: true } : {}),
    ...(input.overlap === "queue" ? { overlap: "queue" as const } : {}),
    ...(input.runOnStartup === true ? { runOnStartup: true } : {}),
  };
}

function normalizeChanges(input: RoutineToolChangesInput, now: number, ownEngine?: string): RoutineRequestChanges {
  const changes: RoutineRequestChanges = {};
  if (input.name !== undefined) changes.name = text(input.name, "name", 80);
  if (input.instructions !== undefined) changes.instructions = text(input.instructions, "instructions", 20_000);
  if (input.schedule !== undefined) changes.schedule = normalizeScheduleChanges(input.schedule, now, ownEngine);
  if (input.runOn !== undefined) changes.runOn = runOn(input.runOn);
  if (input.durationMinutes !== undefined) changes.durationMinutes = duration(input.durationMinutes);
  if (input.timeoutMinutes !== undefined) changes.timeoutMinutes = timeout(input.timeoutMinutes);
  if (input.continuity !== undefined) changes.continuity = input.continuity === true;
  if (input.overlap !== undefined) changes.overlap = input.overlap;
  if (input.runOnStartup !== undefined) changes.runOnStartup = input.runOnStartup === true;
  return changes;
}

function routineId(value: string): string {
  if (!ROUTINE_ID.test(value)) throw new RoutineRequestError("Choose a valid routine id");
  return value;
}

function ownedRoutine(manager: RoutineManager, id: string, botId: string): Routine | null {
  return manager.listRoutines().find((routine) => routine.id === id && routine.botId === botId) ?? null;
}

function noFutureResumeMessage(schedule: RoutineSchedule): string {
  if (schedule.type === "interval") {
    return "That interval routine has no future runs. Choose a later end time or remove the end restriction before resuming.";
  }
  if (schedule.type === "once") {
    return "That one-time routine's scheduled time has passed. Update it to a new future time before resuming.";
  }
  return "That routine has no future runs. Update its schedule before resuming.";
}

function normalizedOperation(
  manager: RoutineManager,
  botId: string,
  validated: ParsedRoutineProposal,
  now: number,
  engines?: LimitResetEngines,
): RoutineRequestOperation {
  const ownEngine = engines?.botEngine(validated.forBot?.botId ?? botId);
  if (validated.action === "create") {
    const operation: Extract<RoutineRequestOperation, { action: "create" }> = {
      action: "create",
      routine: normalizeDefinition(validated.routine, now, ownEngine),
    };
    if (validated.forBot) operation.forBot = validated.forBot;
    return operation;
  }
  const id = routineId(validated.routineId);
  // Ownership and every run's permissions stay with the named bot.
  const ownerBotId = validated.forBot?.botId ?? botId;
  const current = ownedRoutine(manager, id, ownerBotId);
  if (!current) throw new RoutineRequestError("That routine does not exist", 404);
  if (validated.action === "update") {
    return {
      action: "update",
      routineId: id,
      expectedUpdatedAt: current.updatedAt,
      changes: normalizeChanges(validated.changes, now, ownEngine),
      ...(validated.forBot ? { forBot: validated.forBot } : {}),
    };
  }
  if (validated.action === "resume" && current.schedule.type !== "limit_reset" && nextOccurrence(current.schedule, now) === null) {
    throw new RoutineRequestError(noFutureResumeMessage(current.schedule), 409);
  }
  return {
    action: validated.action,
    routineId: id,
    expectedUpdatedAt: current.updatedAt,
    ...(validated.forBot ? { forBot: validated.forBot } : {}),
  };
}

export function asSchedule(schedule: RoutineRequestSchedule, now: number): RoutineSchedule {
  if (schedule.type === "cron") return { ...schedule };
  if (schedule.type === "limit_reset") return { type: "limit_reset", engine: schedule.engine, repeat: schedule.repeat, at: null };
  if (schedule.type === "once") return { type: "once", at: schedule.at };
  if (schedule.type === "interval") {
    return {
      type: "interval",
      everyMinutes: schedule.everyMinutes,
      anchorAt: schedule.anchorAt ?? now,
      ...(schedule.weekdays === undefined ? {} : { weekdays: [...schedule.weekdays] }),
      ...(schedule.window === undefined ? {} : { window: { ...schedule.window } }),
      ...(schedule.endsAt === undefined ? {} : { endsAt: schedule.endsAt }),
    };
  }
  return { type: "daily", time: schedule.time, weekdays: [...schedule.weekdays] };
}

function schedulePatch(
  schedule: RoutineRequestScheduleChanges,
  now: number,
  current: RoutineSchedule,
): RoutineScheduleInput {
  if (schedule.type !== "interval") return asSchedule(schedule, now);
  return {
    type: "interval",
    everyMinutes: schedule.everyMinutes,
    anchorAt: schedule.anchorAt ?? (current.type === "interval" ? current.anchorAt : now),
    ...(Object.hasOwn(schedule, "weekdays")
      ? { weekdays: schedule.weekdays === null ? null : [...schedule.weekdays!] }
      : {}),
    ...(Object.hasOwn(schedule, "window")
      ? { window: schedule.window === null ? null : { ...schedule.window! } }
      : {}),
    ...(Object.hasOwn(schedule, "endsAt") ? { endsAt: schedule.endsAt } : {}),
  };
}

function effectiveSchedule(
  current: RoutineRequestSchedule,
  incoming: RoutineRequestScheduleChanges,
): RoutineRequestSchedule {
  if (incoming.type === "cron" || incoming.type === "limit_reset") return { ...incoming };
  if (incoming.type !== "interval") {
    return incoming.type === "once"
      ? { type: "once", at: incoming.at }
      : { type: "daily", time: incoming.time, weekdays: [...incoming.weekdays] };
  }
  const previous = current.type === "interval" ? current : undefined;
  const merged: Extract<RoutineRequestSchedule, { type: "interval" }> = {
    type: "interval",
    everyMinutes: incoming.everyMinutes,
    ...(incoming.anchorAt !== undefined
      ? { anchorAt: incoming.anchorAt }
      : previous?.anchorAt !== undefined
        ? { anchorAt: previous.anchorAt }
        : {}),
  };
  const weekdays = incoming.weekdays === undefined ? previous?.weekdays : incoming.weekdays;
  if (weekdays !== undefined && weekdays !== null) merged.weekdays = [...weekdays];
  const window = incoming.window === undefined ? previous?.window : incoming.window;
  if (window !== undefined && window !== null) merged.window = { ...window };
  const endsAt = incoming.endsAt === undefined ? previous?.endsAt : incoming.endsAt;
  if (endsAt !== undefined && endsAt !== null) merged.endsAt = endsAt;
  return merged;
}

/** Names an engine and says when its usage limit resets, for a limit-reset routine's card. */
export interface LimitResetEngines {
  name(engine: string): string;
  resetAt(engine: string): number | null;
  /** The engine a bot works on now, for a limit-reset routine that names none. */
  botEngine(botId: string): string | undefined;
}

/** A stored routine's schedule as a request names it: a limit-reset time is the engine's, never part of the request. */
function requestSchedule(schedule: RoutineSchedule): RoutineRequestSchedule {
  if (schedule.type === "limit_reset") return { type: "limit_reset", engine: schedule.engine, repeat: schedule.repeat };
  if (schedule.type === "interval") {
    return { ...schedule, ...(schedule.weekdays ? { weekdays: [...schedule.weekdays] } : {}), ...(schedule.window ? { window: { ...schedule.window } } : {}) };
  }
  return schedule.type === "daily" ? { ...schedule, weekdays: [...schedule.weekdays] } : { ...schedule };
}

function nextForOperation(operation: RoutineRequestOperation, manager: RoutineManager, now: number, engines?: LimitResetEngines): number | null {
  const limit = operation.action === "create" || operation.action === "update" ? effectiveDefinition(operation, manager)?.schedule : undefined;
  if (limit?.type === "limit_reset") return limitResetOccurrence(engines?.resetAt(limit.engine) ?? null);
  if (operation.action === "create") {
    if (operation.routine.schedule.type === "interval" && operation.routine.schedule.anchorAt === undefined) return null;
    return nextOccurrence(asSchedule(operation.routine.schedule, now), now);
  }
  const current = manager.listRoutines().find((routine) => routine.id === operation.routineId);
  if (!current) return null;
  if (operation.action === "pause" || operation.action === "delete") return null;
  if (operation.action === "run_now") return now;
  if (operation.action === "resume") return nextOccurrence(current.schedule, now);
  if (!("changes" in operation)) return null;
  if (!current.enabled) return null;
  const definition = effectiveDefinition(operation, manager);
  if (!definition) return null;
  if (definition.schedule.type === "interval" && definition.schedule.anchorAt === undefined) return null;
  const schedule = asSchedule(definition.schedule, now);
  return nextOccurrence(schedule, now);
}

function formatInstant(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString();
  }
}

export function scheduleText(schedule: RoutineRequestSchedule, timeZone: string, engines?: LimitResetEngines): string {
  if (schedule.type === "cron") return `${cronScheduleLabel(schedule)} · Cron: ${schedule.expression}`;
  if (schedule.type === "limit_reset") {
    const name = engines?.name(schedule.engine) ?? schedule.engine;
    return schedule.repeat === "every_reset" ? `Each time ${name}'s usage limit resets` : `When ${name}'s usage limit resets`;
  }
  const zone = plainTimeZone(timeZone);
  if (schedule.type === "once") return `${formatInstant(schedule.at, timeZone)} ${zone}`;
  if (schedule.type === "interval") {
    const restricted = intervalHasRestrictions(schedule);
    const cadence = schedule.anchorAt === undefined
      ? restricted
        ? `Every ${schedule.everyMinutes} minutes, cadence starting at confirmation; first run is the next allowed time`
        : `Every ${schedule.everyMinutes} minutes, starting one interval after confirmation`
      : `Every ${schedule.everyMinutes} minutes, anchored at ${formatInstant(schedule.anchorAt, timeZone)} ${zone}`;
    const restrictions = [
      schedule.weekdays?.length
        ? `on ${plainWeekdays(schedule.weekdays)} (${zone})`
        : null,
      schedule.window ? `during ${plainClock(schedule.window.start)}–${plainClock(schedule.window.end)} ${zone}` : null,
      schedule.endsAt !== undefined ? `until ${formatInstant(schedule.endsAt, timeZone)} ${zone}` : null,
    ].filter((part): part is string => part !== null);
    return restrictions.length ? `${cadence} · ${restrictions.join(" · ")}` : cadence;
  }
  return `${plainWeekdays(schedule.weekdays)} at ${plainClock(schedule.time)} ${zone}`;
}

export function consequenceLine(schedule: RoutineRequestSchedule, continuity = false): string {
  const session = continuity ? "each run starts a fresh session with the previous run's report" : "each run starts a fresh session";
  if (schedule.type === "cron") return `Will run at matching calendar times, ${plainTimeZone(schedule.timeZone)}; ${session}.`;
  if (schedule.type === "once") return "Will run once; that run starts a fresh session.";
  if (schedule.type === "limit_reset") {
    return schedule.repeat === "every_reset"
      ? "Will run a minute after each time that usage limit resets, in this conversation."
      : "Will run once, a minute after that usage limit resets, and continue in this conversation.";
  }
  if (schedule.type === "interval") {
    if (intervalHasRestrictions(schedule)) {
      return `Will run every ${schedule.everyMinutes} minutes when its day, time, and end restrictions allow; ${session}.`;
    }
    const runsPerDay = Math.round(1440 / schedule.everyMinutes);
    const cadence = runsPerDay <= 1 ? "about once a day" : `about ${runsPerDay} times a day`;
    return `Will run ${cadence}; ${session}.`;
  }
  const days = schedule.weekdays.length;
  const cadence = days === 7 ? "every day" : days === 1 ? "one day a week" : `${days} days a week`;
  return `Will run ${cadence}; ${session}.`;
}

function effectiveDefinition(operation: RoutineRequestOperation, manager: RoutineManager): RoutineRequestDefinition | null {
  if (operation.action === "create") return operation.routine;
  const existing = manager.listRoutines().find((routine) => routine.id === operation.routineId);
  if (!existing) return null;
  const base: RoutineRequestDefinition = {
    name: existing.name,
    instructions: existing.prompt,
    schedule: requestSchedule(existing.schedule),
    runOn: existing.runOn,
    durationMinutes: existing.durationMinutes,
    ...(existing.timeoutMinutes === undefined ? {} : { timeoutMinutes: existing.timeoutMinutes }),
    ...(existing.continuity ? { continuity: true } : {}),
    ...(existing.overlap ? { overlap: existing.overlap } : {}),
    ...(existing.runOnStartup ? { runOnStartup: true } : {}),
  };
  if (operation.action !== "update") return base;
  const { schedule, timeoutMinutes, ...changes } = operation.changes;
  const merged: RoutineRequestDefinition = {
    ...base,
    ...changes,
    ...(schedule === undefined ? {} : { schedule: effectiveSchedule(base.schedule, schedule) }),
  };
  if (timeoutMinutes === null) delete merged.timeoutMinutes;
  else if (timeoutMinutes !== undefined) merged.timeoutMinutes = timeoutMinutes;
  if (runsOnce(merged.schedule)) delete merged.runOnStartup;
  return merged;
}

function cardCopy(
  operation: RoutineRequestOperation,
  manager: RoutineManager,
  timeZone: string,
  now: number,
  engines?: LimitResetEngines,
): RoutineCardCopy {
  const definition = effectiveDefinition(operation, manager);
  const actionCopy = ACTION_COPY[operation.action];
  const actionLabel = actionCopy.title;
  const name = redactSecretsInText(definition?.name ?? "routine");
  const forBot = operation.forBot;
  const forSuffix = forBot ? ` for @${redactSecretsInText(forBot.name)}` : "";
  const title = `${actionLabel} “${name}”${forSuffix}?`;
  if (!definition) {
    return {
      title,
      summary: title,
      detail: `Action: ${actionCopy.detail}\nName: ${name}`,
      nextRunAt: null,
      tool: "manage_routine",
    };
  }
  const nextRunAt = nextForOperation(operation, manager, now, engines);
  const scheduleTimeZone = definition.schedule.type === "cron" ? definition.schedule.timeZone : timeZone;
  const when = operation.action === "run_now" ? "Now" : scheduleText(definition.schedule, timeZone, engines);
  const destination = definition.runOn === "cloud" ? "Bot’s current model on its cloud desktop" : "Bot’s current model, where it usually works";
  const current = operation.action === "create"
    ? null
    : manager.listRoutines().find((routine) => routine.id === operation.routineId) ?? null;
  const remainsPaused = operation.action === "update" && current?.enabled === false;
  const deferredInterval = definition.schedule.type === "interval" && definition.schedule.anchorAt === undefined;
  const deferredRestrictedInterval = deferredInterval &&
    definition.schedule.type === "interval" &&
    intervalHasRestrictions(definition.schedule);
  const nextDescription = remainsPaused
    ? "None — this routine remains paused"
    : deferredInterval
      ? deferredRestrictedInterval
        ? `Next allowed time after confirmation (${plainTimeZone(timeZone)})`
        : "One interval after confirmation"
      : nextRunAt !== null
        ? formatInstant(nextRunAt, scheduleTimeZone)
        : operation.action === "pause"
          ? "None — this routine will be paused"
          : operation.action === "delete"
            ? "None — this routine will be deleted"
            : definition.schedule.type === "limit_reset" ? "When that limit resets (the time is not known yet)" : "None";
  const status = remainsPaused ? " · Remains paused" : "";
  // Credential-shaped values never travel back through the bot's MCP response or into the transcript.
  const visibleInstructions = redactSecretsInText(definition.instructions);
  const runLimit = definition.timeoutMinutes === undefined
    ? "no run limit"
    : `${definition.timeoutMinutes} min limit`;
  return {
    title,
    summary: `${actionLabel} “${name}”${forSuffix} · ${when} · ${destination} · ${runLimit}${status}`,
    detail: [
      `Action: ${actionCopy.detail}`,
      `Name: ${name}`,
      ...(forBot ? [`For: @${redactSecretsInText(forBot.name)} — each run uses that bot's AI and permissions`] : []),
      `Schedule: ${when}`,
      `Next run: ${nextDescription}`,
      ...(definition.schedule.type === "cron" && nextRunAt !== null && operation.action !== "run_now"
        ? [`Next 3 runs (${plainTimeZone(scheduleTimeZone)}): ${nextCronRuns(definition.schedule, now, 3).map((at) => formatInstant(at, scheduleTimeZone)).join(" · ")}`]
        : []),
      `Runs on: ${destination}`,
      `Run limit: ${definition.timeoutMinutes === undefined ? "No limit" : `${definition.timeoutMinutes} minutes`}`,
      `Continuity: ${definition.continuity ? "Carries the previous run's report into the next run" : "Each run starts fresh"}`,
      `While busy: ${definition.overlap === "queue" ? "Queue one scheduled run; skip further occurrences until it starts" : "Skip overlapping scheduled occurrences"}`,
      ...(definition.runOnStartup || (operation.action === "update" && operation.changes.runOnStartup !== undefined)
        ? [`On startup: ${definition.runOnStartup ? "Also runs once each time OpenMausBot starts" : "Runs only on its schedule"}`]
        : []),
      ...(operation.action === "create" || operation.action === "update"
        ? [consequenceLine(definition.schedule, Boolean(definition.continuity))]
        : []),
      "",
      "Instructions:",
      visibleInstructions,
    ].join("\n"),
    nextRunAt,
    tool: operation.action === "create" ? "schedule_routine" : "manage_routine",
  };
}

function inputFromDefinition(definition: RoutineRequestDefinition, botId: string, now: number): RoutineInput {
  return {
    name: definition.name,
    prompt: definition.instructions,
    botId,
    runOn: definition.runOn,
    enabled: true,
    schedule: asSchedule(definition.schedule, now),
    durationMinutes: definition.durationMinutes,
    ...(definition.timeoutMinutes === undefined ? {} : { timeoutMinutes: definition.timeoutMinutes }),
    ...(definition.continuity ? { continuity: true } : {}),
    ...(definition.overlap === "queue" ? { overlap: "queue" as const } : {}),
    ...(definition.runOnStartup ? { runOnStartup: true } : {}),
  };
}

function updateFromChanges(
  changes: RoutineRequestChanges,
  now: number,
  currentSchedule: RoutineSchedule,
): Partial<RoutineInput> {
  const patch: Partial<RoutineInput> = {};
  if (changes.name !== undefined) patch.name = changes.name;
  if (changes.instructions !== undefined) patch.prompt = changes.instructions;
  if (changes.schedule !== undefined) patch.schedule = schedulePatch(changes.schedule, now, currentSchedule);
  if (changes.runOn !== undefined) patch.runOn = changes.runOn;
  if (changes.durationMinutes !== undefined) patch.durationMinutes = changes.durationMinutes;
  if (changes.timeoutMinutes !== undefined) patch.timeoutMinutes = changes.timeoutMinutes;
  if (changes.continuity !== undefined) patch.continuity = changes.continuity;
  if (changes.overlap !== undefined) patch.overlap = changes.overlap;
  if (changes.runOnStartup !== undefined) patch.runOnStartup = changes.runOnStartup;
  return patch;
}

function canonicalValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalValue);
  const parsedObject = jsonObjectSchema.safeParse(value);
  if (!parsedObject.success) return value;
  const sorted: JsonObject = {};
  for (const key of Object.keys(parsedObject.data).sort()) {
    const child = parsedObject.data[key];
    if (child !== undefined) sorted[key] = canonicalValue(child);
  }
  return sorted;
}

/** Bound to the card owner as well as the operation; sorted keys keep old receipts valid across refactors. */
export function routineRequestFingerprint(
  payload: Pick<RoutineRequestCardData, "version" | "requestId" | "botId" | "threadId" | "operation">,
  messageId: string,
): string {
  const document = parseJson(JSON.stringify({
    fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
    cardVersion: payload.version,
    requestId: payload.requestId,
    messageId,
    botId: payload.botId,
    threadId: payload.threadId,
    operation: payload.operation,
  }));
  return createHash("sha256").update(JSON.stringify(canonicalValue(document))).digest("hex");
}

function verifyManageSnapshot(
  operation: Exclude<RoutineRequestOperation, { action: "create" }>,
  manager: RoutineManager,
  botId: string,
): Routine {
  const current = ownedRoutine(manager, operation.routineId, botId);
  if (!current) throw new RoutineRequestError("That routine no longer exists", 404, { terminal: true });
  if (current.updatedAt !== operation.expectedUpdatedAt) {
    throw new RoutineRequestError(
      "That routine changed after this confirmation card was prepared. Ask the bot to review it and propose the action again.",
      409,
      { terminal: true },
    );
  }
  return current;
}

function requestCommit(payload: RoutineRequestCardData, messageId: string): RoutineRequestCommit {
  return {
    requestId: payload.requestId,
    messageId,
    botId: payload.botId,
    threadId: payload.threadId,
    action: payload.operation.action,
    fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
    fingerprint: routineRequestFingerprint(payload, messageId),
  };
}

function revalidateOperation(operation: RoutineRequestOperation, manager: RoutineManager, botId: string, now: number): void {
  if (operation.action === "create") {
    const definition = operation.routine;
    const owner = operation.forBot?.botId ?? botId;
    const schedule = asSchedule(definition.schedule, now);
    const duplicate = manager.listRoutines().find((routine) => {
      if (!routine.enabled || routine.target !== "bot" || routine.botId !== owner
        || routine.runOn !== definition.runOn || routine.prompt !== definition.instructions
        || routine.durationMinutes !== definition.durationMinutes
        || routine.timeoutMinutes !== definition.timeoutMinutes
        || Boolean(routine.continuity) !== Boolean(definition.continuity)
        || (routine.overlap ?? "skip") !== (definition.overlap ?? "skip")
        || Boolean(routine.runOnStartup) !== Boolean(definition.runOnStartup)
        || (routine.attachments?.length ?? 0) > 0) return false;
      if (schedule.type === "limit_reset" || routine.schedule.type === "limit_reset") {
        return schedule.type === routine.schedule.type && isDeepStrictEqual(requestSchedule(schedule), requestSchedule(routine.schedule));
      }
      const candidate = schedule.type === "interval" && routine.schedule.type === "interval"
        && definition.schedule.type === "interval" && definition.schedule.anchorAt === undefined
        ? { ...schedule, anchorAt: routine.schedule.anchorAt }
        : schedule;
      return isDeepStrictEqual(candidate, routine.schedule);
    });
    if (duplicate) {
      // The tool cannot choose a result destination.
      throw new RoutineRequestError(
        `An enabled routine with the same instructions and execution settings already exists (${duplicate.id}). Use trigger_info to review it, then change or run that trigger instead.`,
        409,
        { terminal: true },
      );
    }
  }
  const current = operation.action === "create"
    ? null
    : verifyManageSnapshot(operation, manager, operation.forBot?.botId ?? botId);
  const schedule = operation.action === "create"
    ? operation.routine.schedule
    : operation.action === "update"
      ? operation.changes.schedule
      : undefined;
  if (schedule?.type === "cron") {
    try {
      normalizeCronSchedule(schedule, now);
    } catch (error) {
      throw new RoutineRequestError(error instanceof Error ? error.message : "Invalid cron schedule", 409);
    }
  }
  const startsWithApp = operation.action === "create"
    ? operation.routine.runOnStartup === true
    : operation.action === "update" && operation.changes.runOnStartup === true;
  const startSchedule = schedule ?? current?.schedule;
  if (startsWithApp && startSchedule && runsOnce(startSchedule)) {
    throw new RoutineRequestError("Only a repeating routine can also run when OpenMausBot starts. A one-time routine just runs at its time.");
  }
  if (schedule?.type === "once" && schedule.at <= now) {
    throw new RoutineRequestError("That one-time schedule is now in the past. Ask the bot to propose a new time.", 409, { terminal: true });
  }
  if (schedule?.type === "interval") {
    const base = operation.action === "create"
      ? operation.routine.schedule
      : current
        ? effectiveSchedule(requestSchedule(current.schedule), schedule)
        : null;
    const concrete = base ? asSchedule(base, now) : null;
    if (concrete) {
      const valid = storedScheduleSchema.safeParse(concrete);
      if (!valid.success) {
        throw new RoutineRequestError(schemaIssue(valid.error, "Invalid interval schedule"));
      }
    }
    if (concrete && nextOccurrence(concrete, now) === null) {
      throw new RoutineRequestError(
        "That interval no longer has a future run. Choose a later end time or remove the end restriction.",
        409,
      );
    }
  }
  if (operation.action === "resume") {
    if (!current) throw new RoutineRequestError("That routine no longer exists", 404);
    if (current.schedule.type !== "limit_reset" && nextOccurrence(current.schedule, now) === null) {
      throw new RoutineRequestError(noFutureResumeMessage(current.schedule), 409);
    }
  }
}

function routineSnapshot(routine: Routine): RoutineRequestSnapshot | undefined {
  if (routine.attachments?.length) return undefined;
  if (redactSecretsInText(routine.name) !== routine.name || redactSecretsInText(routine.prompt) !== routine.prompt) return undefined;
  const snapshot: RoutineRequestSnapshot = {
    name: routine.name,
    instructions: routine.prompt,
    schedule: requestSchedule(routine.schedule),
    runOn: routine.runOn,
    durationMinutes: routine.durationMinutes,
    ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
    ...(routine.continuity ? { continuity: true } : {}),
    ...(routine.overlap === "queue" ? { overlap: "queue" as const } : {}),
    ...(routine.runOnStartup ? { runOnStartup: true } : {}),
    enabled: routine.enabled,
    ...(routine.target === "room-goal" ? { target: "room-goal" as const } : {}),
    ...(routine.groupId ? { groupId: routine.groupId } : {}),
    ...(routine.resultsThreadId ? { resultsThreadId: routine.resultsThreadId } : {}),
  };
  return storedSnapshotSchema.safeParse(snapshot).success ? snapshot : undefined;
}

function restorePatch(before: RoutineRequestSnapshot, now: number): Partial<RoutineInput> {
  const schedule = asSchedule(before.schedule, now);
  return {
    name: before.name,
    prompt: before.instructions,
    runOn: before.runOn,
    schedule: schedule.type === "interval"
      ? { ...schedule, weekdays: schedule.weekdays ?? null, window: schedule.window ?? null, endsAt: schedule.endsAt ?? null }
      : schedule,
    durationMinutes: before.durationMinutes,
    timeoutMinutes: before.timeoutMinutes ?? null,
    continuity: before.continuity === true,
    overlap: before.overlap ?? "skip",
    runOnStartup: before.runOnStartup === true,
  };
}

export class RoutineRequestService {
  private readonly store: RoutineRequestStore;
  private readonly routines: RoutineManager;
  private readonly now: () => number;
  private readonly timeZone: () => string;
  private readonly cloudReady?: (botId: string) => Promise<{ ready: boolean; reason?: string }>;
  private readonly canPersist?: RoutineRequestServiceOptions["canPersist"];
  private readonly validateTarget?: RoutineRequestServiceOptions["validateTarget"];
  private readonly autoApply?: RoutineRequestServiceOptions["autoApply"];
  private readonly engines?: LimitResetEngines;

  constructor(options: RoutineRequestServiceOptions) {
    this.store = options.store;
    this.routines = options.routines;
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    this.cloudReady = options.cloudReady;
    this.canPersist = options.canPersist;
    this.validateTarget = options.validateTarget;
    this.autoApply = options.autoApply;
    this.engines = options.engines;
  }

  /** Writes the card without applying it, the first half of submit(); no production path stops here since Triggers v2. */
  async propose(args: ProposeRoutineRequestArgs): Promise<RoutineProposalResult> {
    return this.prepare(args);
  }

  /** Applies the change at once and records it on a card with Undo; it throws rather than leave anything pending. */
  async submit(args: ProposeRoutineRequestArgs) {
    const proposal = await this.prepare(args, true);
    return { ...proposal, state: "applied" as const };
  }

  private async prepare(args: ProposeRoutineRequestArgs, submitted = false): Promise<RoutineProposalResult & {
    result?: Extract<ResolveRoutineRequestResult, { state: "applied" }>;
    appliedBy?: DirectApply;
  }> {
    const botId = text(args.botId, "botId", 128);
    const threadId = text(args.threadId, "threadId", 128);
    const at = this.now();
    const parsedProposal = routineProposalSchema.safeParse(args.proposal);
    if (!parsedProposal.success) {
      throw new RoutineRequestError(schemaIssue(parsedProposal.error, "Invalid routine proposal"));
    }
    const operation = normalizedOperation(this.routines, botId, parsedProposal.data, at, this.engines);
    if (operation.forBot && this.validateTarget) {
      const refusal = this.validateTarget(botId, operation.forBot);
      if (refusal) throw new RoutineRequestError(refusal, 403);
    }
    await this.requireCloudReadiness(operation, botId);
    // The probe is async: re-check the captured revision before persisting the snapshot.
    const cardAt = this.now();
    revalidateOperation(operation, this.routines, botId, cardAt);
    const requestId = newId();
    const payload: RoutineRequestCardData = {
      version: 1,
      requestId,
      botId,
      threadId,
      createdAt: cardAt,
      operation,
    };
    const definition = effectiveDefinition(operation, this.routines);
    const timeZone = definition?.schedule.type === "cron" ? definition.schedule.timeZone : this.timeZone();
    const copy = cardCopy(operation, this.routines, timeZone, cardAt, this.engines);
    const messageInput: Parameters<RoutineRequestStore["appendMessage"]>[1] = {
      role: "bot",
      kind: "options",
      card: {
        title: copy.title,
        subtitle: copy.detail,
        options: ["Confirm", "Cancel"],
        requestId,
        tool: copy.tool,
        routineRequest: payload,
      },
    };
    if (args.from) messageInput.from = args.from;
    const owner = operation.forBot?.botId ?? botId;
    // A submitted change always applies: OpenMausBot shows no confirmation card of its own. The grant only names why.
    const grant = submitted ? this.autoApply?.(botId, threadId, owner) ?? null : null;
    const automatic = submitted;
    // Check and append stay adjacent and synchronous, so no other proposal can interleave.
    const persistence = this.canPersist?.(botId, threadId, !automatic);
    if (persistence && !persistence.ok) {
      throw new RoutineRequestError(persistence.error, persistence.status);
    }
    if (args.canCommit && !args.canCommit()) {
      throw new RoutineRequestError("The requesting turn ended before this proposal could be saved", 401);
    }
    const before = automatic && (operation.action === "update" || operation.action === "delete")
      ? this.snapshotOf(operation.routineId, owner)
      : undefined;
    if (automatic) {
      messageInput.card.options = [];
      messageInput.card.dismissed = true;
    }
    const message = this.store.appendMessage(threadId, messageInput);
    const proposal = {
      requestId,
      messageId: message.id,
      title: copy.title,
      summary: copy.summary,
      detail: copy.detail,
      nextRunAt: copy.nextRunAt,
      timeZone,
    };
    if (!automatic) return proposal;
    let result: ResolveRoutineRequestResult;
    try {
      result = this.resolve({ botId, threadId, requestId, behavior: "allow" });
    } catch (error) {
      result = { claimed: true, state: "invalid", error: error instanceof Error ? error.message : String(error), status: error instanceof RoutineRequestError ? error.status : 400 };
    }
    if (result.state === "applied") {
      this.recordAutoApplied(threadId, message.id, definition, before);
      return { ...proposal, result, ...(grant ? { appliedBy: grant } : {}) };
    }
    const receipt = this.routines.routineRequestReceipt(requestId);
    if (receipt && receipt.botId === botId && receipt.threadId === threadId && receipt.messageId === message.id &&
      receipt.fingerprintVersion === ROUTINE_REQUEST_FINGERPRINT_VERSION && receipt.fingerprint === routineRequestFingerprint(payload, message.id)) {
      return { ...proposal, result: {
        claimed: true, state: "applied", action: receipt.action, resultId: receipt.resultId,
        settlementPending: true, message: "Routine change applied. Recording the operation receipt could not finish; the change will not be applied again.",
      }, ...(grant ? { appliedBy: grant } : {}) };
    }
    throw new RoutineRequestError(result.state === "invalid" ? result.error : "The routine change could not be applied", result.state === "invalid" ? result.status : 409);
  }

  private snapshotOf(routineId: string, owner: string): RoutineRequestSnapshot | undefined {
    const routine = ownedRoutine(this.routines, routineId, owner);
    return routine ? routineSnapshot(routine) : undefined;
  }

  private recordAutoApplied(
    threadId: string,
    messageId: string,
    definition: RoutineRequestDefinition | null,
    before: RoutineRequestSnapshot | undefined,
  ): void {
    try {
      const message = this.store.messagesFor(threadId).find((candidate) => candidate.id === messageId);
      const card = message?.card;
      const payload = card?.routineRequest;
      if (!message || !card || !payload) return;
      const action = payload.operation.action;
      const routineId = payload.operation.action === "create" ? payload.resultId : payload.operation.routineId;
      const after = routineId ? this.routines.listRoutines().find((routine) => routine.id === routineId) : undefined;
      const undo: RoutineRequestUndo = {
        name: redactSecretsInText(after?.name ?? definition?.name ?? before?.name ?? "routine"),
        ...(action === "create" || action === "update" || action === "resume"
          ? { schedule: after ? requestSchedule(after.schedule) : structuredClone(definition?.schedule) }
          : {}),
        ...(after && (action === "update" || action === "pause" || action === "resume") ? { appliedUpdatedAt: after.updatedAt } : {}),
        ...(before ? { before } : {}),
      };
      if (!storedUndoSchema.safeParse(undo).success) delete undo.schedule;
      this.store.patchMessage(threadId, messageId, {
        card: { ...card, autoApplied: true, routineRequest: { ...payload, undo } },
      });
    } catch {
    }
  }

  undo(args: { botId: string; threadId: string; requestId: string }): UndoRoutineRequestResult {
    const message = this.store
      .messagesFor(args.threadId)
      .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.routineRequest);
    const card = message?.card;
    if (!message || !card) return { claimed: false };
    if (card.undone) return { claimed: true, state: "already_undone" };
    const cannot = (error: string, status = 409): UndoRoutineRequestResult => ({ claimed: true, state: "invalid", error, status });
    if (!card.autoApplied || card.answered !== "allow") return cannot("Only a change that applied on its own can be undone here.");
    const parsed = routineRequestCardDataSchema.safeParse(card.routineRequest);
    if (!parsed.success) return cannot("This change can't be undone here.");
    const payload: RoutineRequestCardData = parsed.data;
    if (payload.botId !== args.botId || payload.threadId !== args.threadId) {
      return cannot("This routine change belongs to another conversation", 403);
    }
    const operation = payload.operation;
    const owner = operation.forBot?.botId ?? payload.botId;
    const undo = payload.undo;
    const stale: UndoRoutineRequestResult = { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
    const now = this.now();
    let routineId: string;
    let restoredId: string | undefined;
    try {
      switch (operation.action) {
        case "run_now":
          return cannot("A routine run can't be undone.");
        case "create": {
          routineId = payload.resultId ?? "";
          if (!routineId || !ownedRoutine(this.routines, routineId, owner)) return stale;
          this.routines.remove(routineId);
          break;
        }
        case "update":
        case "pause":
        case "resume": {
          routineId = operation.routineId;
          if (undo?.appliedUpdatedAt === undefined || (operation.action === "update" && !undo.before)) {
            return cannot("This change can't be undone here.");
          }
          const current = ownedRoutine(this.routines, routineId, owner);
          if (!current || current.updatedAt !== undo.appliedUpdatedAt) return stale;
          const patch = operation.action === "update"
            ? restorePatch(undo.before!, now)
            : { enabled: operation.action === "pause" };
          if (!this.routines.update(routineId, patch)) return stale;
          break;
        }
        case "delete": {
          routineId = operation.routineId;
          const before = undo?.before;
          if (!before) return cannot("This change can't be undone here.");
          restoredId = this.routines.create({
            name: before.name,
            prompt: before.instructions,
            botId: owner,
            ...(before.target ? { target: before.target, groupId: before.groupId } : {}),
            runOn: before.runOn,
            enabled: before.enabled,
            schedule: asSchedule(before.schedule, now),
            durationMinutes: before.durationMinutes,
            ...(before.timeoutMinutes === undefined ? {} : { timeoutMinutes: before.timeoutMinutes }),
            ...(before.continuity ? { continuity: true } : {}),
            ...(before.overlap === "queue" ? { overlap: "queue" as const } : {}),
            ...(before.runOnStartup ? { runOnStartup: true } : {}),
            ...(before.resultsThreadId ? { resultsThreadId: before.resultsThreadId } : {}),
          }).id;
          break;
        }
        default:
          return cannot("This change can't be undone here.");
      }
    } catch (error) {
      return cannot(redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 500));
    }
    this.store.patchMessage(args.threadId, message.id, { card: { ...card, undone: true } });
    return {
      claimed: true,
      state: "undone",
      action: operation.action,
      routineId,
      ...(restoredId ? { restoredId } : {}),
      ...(undo?.ownersBefore !== undefined ? { ownersBefore: undo.ownersBefore } : {}),
    };
  }

  private async requireCloudReadiness(operation: RoutineRequestOperation, proposerBotId: string): Promise<void> {
    if (!this.cloudReady || operation.action === "pause" || operation.action === "delete") return;
    const definition = effectiveDefinition(operation, this.routines);
    if (definition?.runOn !== "cloud") return;
    let readiness: { ready: boolean; reason?: string };
    try {
      const targetBotId = operation.action === "create"
        ? operation.forBot?.botId ?? proposerBotId
        : this.routines.listRoutines().find(routine => routine.id === operation.routineId)?.botId ?? proposerBotId;
      readiness = await this.cloudReady(targetBotId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RoutineRequestError(`Could not verify cloud readiness: ${detail}`, 503);
    }
    if (readiness.ready) return;
    throw new RoutineRequestError(
      readiness.reason?.trim() || "Running in the cloud isn't set up yet. Set up a cloud desktop first.",
      409,
    );
  }

  /** Claims a card even after it settled: a duplicate click must never fall through to a provider that did not create the request id. */
  resolve(args: {
    botId: string;
    threadId: string;
    requestId: string;
    behavior: string | undefined;
  }): ResolveRoutineRequestResult {
    const message = this.store
      .messagesFor(args.threadId)
      .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.routineRequest);
    const card = message?.card;
    const rawPayload = card?.routineRequest;
    if (!message || !card || !rawPayload) return { claimed: false, state: "not_found" };
    if (args.behavior !== "allow" && args.behavior !== "deny") {
      return {
        claimed: true,
        state: "invalid",
        error: "Routine confirmations must be confirmed or cancelled",
        status: 400,
      };
    }
    const parsedPayload = routineRequestCardDataSchema.safeParse(rawPayload);
    if (!parsedPayload.success) {
      if (card.answered) return { claimed: true, state: "already_settled", behavior: card.answered };
      const recovered = this.settleCommittedReceipt(args, message.id, card);
      if (recovered) return recovered;
      // Deny stays possible when an old payload fails today's schema; otherwise the card owns the composer forever.
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      const detail = schemaIssue(parsedPayload.error, "This routine request is invalid");
      this.store.patchMessage(args.threadId, message.id, {
        card: { ...card, held: redactSecretsInText(detail).slice(0, 500) },
      });
      return { claimed: true, state: "invalid", error: detail, status: 400 };
    }
    const payload: RoutineRequestCardData = parsedPayload.data;
    if (payload.requestId !== args.requestId) {
      const recovered = this.settleCommittedReceipt(args, message.id, card);
      if (recovered) return recovered;
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      return { claimed: true, state: "invalid", error: "This routine request id does not match its confirmation card", status: 400 };
    }
    if (payload.botId !== args.botId || payload.threadId !== args.threadId) {
      const recovered = this.settleCommittedReceipt(args, message.id, card);
      if (recovered) return recovered;
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      return { claimed: true, state: "invalid", error: "This routine request belongs to another conversation", status: 403 };
    }
    if (card.answered) {
      this.forgetSettledReceipt(payload, message.id);
      return { claimed: true, state: "already_settled", behavior: card.answered };
    }

    try {
      const fingerprint = routineRequestFingerprint(payload, message.id);
      const receipt = this.routines.routineRequestReceipt(payload.requestId);
      if (receipt) {
        if (
          receipt.botId !== payload.botId ||
          receipt.threadId !== payload.threadId ||
          receipt.messageId !== message.id ||
          receipt.action !== payload.operation.action ||
          receipt.fingerprintVersion !== ROUTINE_REQUEST_FINGERPRINT_VERSION ||
          receipt.fingerprint !== fingerprint
        ) {
          throw new RoutineRequestError("This routine request does not match its durable commit receipt", 409);
        }
        return this.settleApplied(
          args.threadId,
          message.id,
          card,
          payload,
          receipt.resultId,
          receipt.appliedAt,
        );
      }
      if (card.expired) {
        return {
          claimed: true,
          state: "invalid",
          error: "This routine request expired before it was confirmed. Ask for a fresh proposal.",
          status: 409,
        };
      }
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      revalidateOperation(payload.operation, this.routines, payload.botId, this.now());
      if (payload.operation.forBot && this.validateTarget) {
        const refusal = this.validateTarget(payload.botId, payload.operation.forBot);
        if (refusal) throw new RoutineRequestError(refusal, 404, { terminal: true });
      }
      const resultId = this.apply(payload, message.id, fingerprint);
      return this.settleApplied(args.threadId, message.id, card, payload, resultId);
    } catch (error) {
      const status = error instanceof RoutineRequestError ? error.status : 400;
      const detail = error instanceof Error ? error.message : String(error);
      const expired = error instanceof RoutineRequestError && error.terminal;
      this.store.patchMessage(args.threadId, message.id, {
        card: { ...card, ...(expired ? { expired: true, options: [] } : {}), held: redactSecretsInText(detail).slice(0, 500) },
      });
      return {
        claimed: true,
        state: "invalid",
        error: detail,
        status,
      };
    }
  }

  private settleApplied(
    threadId: string,
    messageId: string,
    card: RoutineRequestOptionCard,
    payload: RoutineRequestCardData,
    resultId: string,
    appliedAt = this.now(),
  ): ResolveRoutineRequestResult {
    const applied: RoutineRequestCardData = {
      ...payload,
      appliedAt,
      resultId,
    };
    const settled = this.store.patchMessage(threadId, messageId, {
      card: { ...card, answered: "allow", held: undefined, routineRequest: applied },
    });
    if (!settled) throw new RoutineRequestError("This routine confirmation card is no longer available", 409);
    this.forgetSettledReceipt(payload, messageId);
    return { claimed: true, state: "applied", action: payload.operation.action, resultId };
  }

  private forgetSettledReceipt(payload: RoutineRequestCardData, messageId: string): void {
    this.forgetReceipt(requestCommit(payload, messageId));
  }

  private settleCommittedReceipt(
    args: { botId: string; threadId: string; requestId: string },
    messageId: string,
    card: RoutineRequestOptionCard,
  ): ResolveRoutineRequestResult | null {
    const receipt = this.routines.routineRequestReceipt(args.requestId);
    if (!receipt) return null;
    if (receipt.botId !== args.botId || receipt.threadId !== args.threadId || receipt.messageId !== messageId) {
      return {
        claimed: true,
        state: "invalid",
        error: "This committed routine request belongs to another conversation",
        status: 403,
      };
    }
    const settled = this.store.patchMessage(args.threadId, messageId, {
      card: { ...card, answered: "allow", held: undefined },
    });
    if (!settled) {
      return {
        claimed: true,
        state: "invalid",
        error: "This routine confirmation card is no longer available",
        status: 409,
      };
    }
    this.forgetReceipt(receipt);
    return {
      claimed: true,
      state: "applied",
      action: receipt.action,
      resultId: receipt.resultId,
    };
  }

  private forgetReceipt(request: RoutineRequestCommit): void {
    try {
      this.routines.forgetRoutineRequestReceipt(request);
    } catch {
    }
  }

  private apply(payload: RoutineRequestCardData, messageId: string, fingerprint: string): string {
    const operation = payload.operation;
    const confirmationAt = this.now();
    switch (operation.action) {
      case "create":
        return this.routines.create(inputFromDefinition(
          operation.routine,
          operation.forBot?.botId ?? payload.botId,
          confirmationAt,
        ), {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: "create",
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        }).id;
      case "update": {
        const current = verifyManageSnapshot(operation, this.routines, operation.forBot?.botId ?? payload.botId);
        const updated = this.routines.update(
          operation.routineId,
          updateFromChanges(operation.changes, confirmationAt, current.schedule),
          {
            requestId: payload.requestId,
            messageId,
            botId: payload.botId,
            threadId: payload.threadId,
            action: "update",
            fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
            fingerprint,
          },
        );
        if (!updated) throw new RoutineRequestError("That routine no longer exists", 404);
        return updated.id;
      }
      case "pause":
      case "resume": {
        verifyManageSnapshot(operation, this.routines, operation.forBot?.botId ?? payload.botId);
        const updated = this.routines.update(operation.routineId, { enabled: operation.action === "resume" }, {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: operation.action,
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        });
        if (!updated) throw new RoutineRequestError("That routine no longer exists", 404);
        return updated.id;
      }
      case "run_now": {
        verifyManageSnapshot(operation, this.routines, operation.forBot?.botId ?? payload.botId);
        const run = this.routines.runNow(operation.routineId, {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: "run_now",
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        });
        if (!run) throw new RoutineRequestError("That routine no longer exists", 404);
        return run.id;
      }
      case "delete":
        verifyManageSnapshot(operation, this.routines, operation.forBot?.botId ?? payload.botId);
        if (!this.routines.remove(operation.routineId, {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: "delete",
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        })) {
          throw new RoutineRequestError("That routine no longer exists", 404);
        }
        return operation.routineId;
      default:
        throw new RoutineRequestError("Unsupported persisted routine action");
    }
  }
}
