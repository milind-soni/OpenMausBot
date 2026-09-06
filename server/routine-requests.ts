import { createHash } from "node:crypto";

import { z } from "zod";

import { newId } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";
import { parseJson, schemaIssue, type JsonObject, type JsonValue } from "./schema.ts";
import {
  nextOccurrence,
  type Routine,
  type RoutineInput,
  type RoutineManager,
  type RoutineRequestCommit,
  type RoutineSchedule,
} from "./routines.ts";
import type {
  RoutineRequestCardData,
  RoutineRequestChanges,
  RoutineRequestDefinition,
  RoutineRequestOperation,
  RoutineRequestRunOn,
  RoutineRequestSchedule,
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

const WEEKDAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const RFC3339_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/i;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ROUTINE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_DATE_MS = 8_640_000_000_000_000;
const ACTION_COPY = {
  create: { title: "Schedule", detail: "Create routine" },
  update: { title: "Update", detail: "Update routine" },
  pause: { title: "Pause", detail: "Pause routine" },
  resume: { title: "Resume", detail: "Resume routine" },
  run_now: { title: "Run now", detail: "Run routine now" },
  delete: { title: "Delete", detail: "Delete routine" },
} as const satisfies Record<RoutineRequestOperation["action"], { title: string; detail: string }>;
const ROUTINE_REQUEST_FINGERPRINT_VERSION = 1 as const;
const jsonObjectSchema = z.record(z.string(), z.custom<JsonValue>());

const routineToolScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), at: z.string().max(64) }).strict(),
  z.object({
    type: z.literal("weekly"),
    time: z.string().max(5),
    weekdays: z.array(z.string().max(9)).min(1).max(7),
  }).strict(),
  z.object({
    type: z.literal("interval"),
    everyMinutes: z.number(),
    anchorAt: z.string().max(64).optional(),
  }).strict(),
]);

const routineToolDefinitionSchema = z.object({
  name: z.string().max(80),
  instructions: z.string().max(20_000),
  schedule: routineToolScheduleSchema,
  runOn: z.enum(["maus", "cloud"]).optional(),
  durationMinutes: z.number().optional(),
  timeoutMinutes: z.number().nullable().optional(),
  continuity: z.boolean().optional(),
}).strict();

const routineToolChangesSchema = routineToolDefinitionSchema
  .omit({ timeoutMinutes: true })
  .partial()
  .extend({ timeoutMinutes: z.number().nullable().optional() })
  .strict()
  .refine(
  (changes) => Object.values(changes).some((value) => value !== undefined),
  "Choose at least one routine field to update",
);

/** Resolved and authorized by the harness route (existence + same section)
 * before it reaches this service; re-authorized again at confirm time. */
const targetBotSchema = z.object({
  botId: z.string().min(1).max(128),
  name: z.string().min(1).max(80),
}).strict();
const routineProposalSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), routine: routineToolDefinitionSchema, forBot: targetBotSchema.optional() }).strict(),
  z.object({ action: z.literal("update"), routineId: z.string().max(128), changes: routineToolChangesSchema }).strict(),
  z.object({ action: z.literal("pause"), routineId: z.string().max(128) }).strict(),
  z.object({ action: z.literal("resume"), routineId: z.string().max(128) }).strict(),
  z.object({ action: z.literal("run_now"), routineId: z.string().max(128) }).strict(),
  z.object({ action: z.literal("delete"), routineId: z.string().max(128) }).strict(),
]);

const storedWeekdaysSchema = z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(
  (weekdays) => new Set(weekdays).size === weekdays.length,
  "Stored routine weekdays must be unique",
);
const storedScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), at: z.number().int().nonnegative() }).strict(),
  z.object({
    type: z.literal("daily"),
    time: z.string().regex(TIME),
    weekdays: storedWeekdaysSchema,
  }).strict(),
  z.object({
    type: z.literal("interval"),
    everyMinutes: z.number().int().min(5).max(1_440),
    anchorAt: z.number().int().nonnegative().max(MAX_DATE_MS).optional(),
  }).strict(),
]);
const storedDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(20_000),
  schedule: storedScheduleSchema,
  runOn: z.enum(["maus", "cloud"]),
  durationMinutes: z.number().int().min(5).max(240),
  timeoutMinutes: z.number().int().min(5).max(240).optional(),
  continuity: z.boolean().optional(),
}).strict();
const storedChangesSchema = storedDefinitionSchema
  .omit({ timeoutMinutes: true })
  .partial()
  .extend({ timeoutMinutes: z.number().int().min(5).max(240).nullable().optional() })
  .strict()
  .refine(
  (changes) => Object.values(changes).some((value) => value !== undefined),
  "Stored routine update must change at least one field",
);
const storedManageBase = {
  routineId: z.string().regex(ROUTINE_ID),
  expectedUpdatedAt: z.number().int().nonnegative(),
};
const storedOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), routine: storedDefinitionSchema, forBot: targetBotSchema.optional() }).strict(),
  z.object({ action: z.literal("update"), ...storedManageBase, changes: storedChangesSchema }).strict(),
  z.object({ action: z.literal("pause"), ...storedManageBase }).strict(),
  z.object({ action: z.literal("resume"), ...storedManageBase }).strict(),
  z.object({ action: z.literal("run_now"), ...storedManageBase }).strict(),
  z.object({ action: z.literal("delete"), ...storedManageBase }).strict(),
]);
const routineRequestCardDataSchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1).max(128),
  botId: z.string().min(1).max(128),
  threadId: z.string().min(1).max(128),
  createdAt: z.number().int().nonnegative(),
  operation: storedOperationSchema,
  appliedAt: z.number().int().nonnegative().optional(),
  resultId: z.string().min(1).max(128).optional(),
}).strict();

export type RoutineToolScheduleInput = z.infer<typeof routineToolScheduleSchema>;
export type RoutineToolDefinitionInput = z.infer<typeof routineToolDefinitionSchema>;
export type RoutineToolChangesInput = z.infer<typeof routineToolChangesSchema>;
export type RoutineProposalInput = z.input<typeof routineProposalSchema>;
type ParsedRoutineProposal = z.output<typeof routineProposalSchema>;

export interface RoutineRequestOptionCard {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  held?: string;
  routineRequest?: RoutineRequestCardData;
}

export interface RoutineRequestMessage {
  id: string;
  card?: RoutineRequestOptionCard;
}

/** Kept narrow so the domain can be tested without constructing the full app store. */
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
  /** Harness-owned readiness check for proposals that would execute in cloud. */
  cloudReady?: () => Promise<{ ready: boolean; reason?: string }>;
  /** Revalidates conversation ownership and capacity synchronously, directly
   * before the card append. This closes races across an async cloud probe. */
  canPersist?: (
    botId: string,
    threadId: string,
  ) => { ok: true } | { ok: false; status: number; error: string };
  /** Re-authorizes a cross-bot target (the card can sit open while the target
   * bot is deleted or moved to another section). Returns the sentence to
   * refuse with, or null to allow. Checked at propose AND confirm time. */
  validateTarget?: (proposerBotId: string, target: { botId: string; name: string }) => string | null;
}

export interface ProposeRoutineRequestArgs {
  botId: string;
  threadId: string;
  /** Untrusted model output; normalized by routineProposalSchema in propose(). */
  proposal: unknown;
  /** Room cards retain the member attribution used by every other bot message. */
  from?: { botId: string; name: string; color: string };
  /** Exact caller/turn lease checked synchronously after any readiness await
   * and immediately before the durable card append. */
  canCommit?: () => boolean;
}

export interface RoutineProposalResult {
  requestId: string;
  messageId: string;
  title: string;
  /** Short response returned to the proposing agent. */
  summary: string;
  /** Exact approval text persisted in the card. */
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
    };

export class RoutineRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "RoutineRequestError";
    this.status = status;
  }
}

function text(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new RoutineRequestError(`${field} is required`);
  if (trimmed.length > max) throw new RoutineRequestError(`${field} must be ${max.toLocaleString("en-US")} characters or fewer`);
  // This payload is hidden under the visible card fields, so the store's
  // shallow card redaction cannot reach it. Scrub before it is persisted.
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

function normalizeSchedule(schedule: RoutineToolScheduleInput, now: number): RoutineRequestSchedule {
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
    if (schedule.anchorAt === undefined) {
      return { type: "interval", everyMinutes: schedule.everyMinutes };
    }
    const anchorAt = rfc3339Instant(
      schedule.anchorAt,
      "Interval starts need an RFC3339 date-time with an explicit timezone offset",
    );
    if (!Number.isSafeInteger(anchorAt) || anchorAt < 0 || anchorAt > MAX_DATE_MS) {
      throw new RoutineRequestError("Choose a valid interval start time");
    }
    return { type: "interval", everyMinutes: schedule.everyMinutes, anchorAt };
  }
  if (!TIME.test(schedule.time)) {
    throw new RoutineRequestError("Weekly schedule time must use 24-hour HH:MM");
  }
  if (schedule.weekdays.length === 0) throw new RoutineRequestError("Choose at least one weekday");
  const weekdays = schedule.weekdays.map((day) => {
    // SAFETY: every key in WEEKDAY_NUMBER is lower-case; membership is
    // checked immediately below before the numeric value is retained.
    const number = WEEKDAY_NUMBER[day.toLowerCase() as keyof typeof WEEKDAY_NUMBER];
    if (number === undefined) throw new RoutineRequestError(`Unsupported weekday: ${day}`);
    return number;
  });
  return { type: "daily", time: schedule.time, weekdays: [...new Set(weekdays)].sort() };
}

function normalizeDefinition(input: RoutineToolDefinitionInput, now: number): RoutineRequestDefinition {
  const timeoutMinutes = timeout(input.timeoutMinutes);
  return {
    name: text(input.name, "name", 80),
    instructions: text(input.instructions, "instructions", 20_000),
    schedule: normalizeSchedule(input.schedule, now),
    runOn: runOn(input.runOn),
    durationMinutes: duration(input.durationMinutes),
    ...(timeoutMinutes == null ? {} : { timeoutMinutes }),
    ...(input.continuity === true ? { continuity: true } : {}),
  };
}

function normalizeChanges(input: RoutineToolChangesInput, now: number): RoutineRequestChanges {
  const changes: RoutineRequestChanges = {};
  if (input.name !== undefined) changes.name = text(input.name, "name", 80);
  if (input.instructions !== undefined) changes.instructions = text(input.instructions, "instructions", 20_000);
  if (input.schedule !== undefined) changes.schedule = normalizeSchedule(input.schedule, now);
  if (input.runOn !== undefined) changes.runOn = runOn(input.runOn);
  if (input.durationMinutes !== undefined) changes.durationMinutes = duration(input.durationMinutes);
  if (input.timeoutMinutes !== undefined) changes.timeoutMinutes = timeout(input.timeoutMinutes);
  if (input.continuity !== undefined) changes.continuity = input.continuity === true;
  return changes;
}

function routineId(value: string): string {
  if (!ROUTINE_ID.test(value)) throw new RoutineRequestError("Choose a valid routine id");
  return value;
}

function ownedRoutine(manager: RoutineManager, id: string, botId: string): Routine | null {
  return manager.listRoutines().find((routine) => routine.id === id && routine.botId === botId) ?? null;
}

function normalizedOperation(
  manager: RoutineManager,
  botId: string,
  validated: ParsedRoutineProposal,
  now: number,
): RoutineRequestOperation {
  if (validated.action === "create") {
    const operation: Extract<RoutineRequestOperation, { action: "create" }> = {
      action: "create",
      routine: normalizeDefinition(validated.routine, now),
    };
    if (validated.forBot) operation.forBot = validated.forBot;
    return operation;
  }
  const id = routineId(validated.routineId);
  const current = ownedRoutine(manager, id, botId);
  if (!current) throw new RoutineRequestError("That routine does not exist", 404);
  if (validated.action === "update") {
    return {
      action: "update",
      routineId: id,
      expectedUpdatedAt: current.updatedAt,
      changes: normalizeChanges(validated.changes, now),
    };
  }
  if (validated.action === "resume" && nextOccurrence(current.schedule, now) === null) {
    throw new RoutineRequestError(
      "That one-time routine's scheduled time has passed. Update it to a new future time before resuming.",
      409,
    );
  }
  return { action: validated.action, routineId: id, expectedUpdatedAt: current.updatedAt };
}

function asSchedule(schedule: RoutineRequestSchedule, now: number): RoutineSchedule {
  if (schedule.type === "once") return { type: "once", at: schedule.at };
  if (schedule.type === "interval") {
    return { type: "interval", everyMinutes: schedule.everyMinutes, anchorAt: schedule.anchorAt ?? now };
  }
  return { type: "daily", time: schedule.time, weekdays: [...schedule.weekdays] };
}

function nextForOperation(operation: RoutineRequestOperation, manager: RoutineManager, now: number): number | null {
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
  if (operation.changes.schedule?.type === "interval" && operation.changes.schedule.anchorAt === undefined) return null;
  const schedule = operation.changes.schedule ? asSchedule(operation.changes.schedule, now) : current.schedule;
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

export function scheduleText(schedule: RoutineRequestSchedule, timeZone: string): string {
  if (schedule.type === "once") return `${formatInstant(schedule.at, timeZone)} (${timeZone})`;
  if (schedule.type === "interval") {
    return schedule.anchorAt === undefined
      ? `Every ${schedule.everyMinutes} minutes, starting one interval after confirmation`
      : `Every ${schedule.everyMinutes} minutes, anchored at ${formatInstant(schedule.anchorAt, timeZone)} (${timeZone})`;
  }
  const days = schedule.weekdays.map((day) => WEEKDAY_LABEL[day]).join(", ");
  return `${days} at ${schedule.time} (${timeZone})`;
}

/** One plain sentence describing how often a routine will actually run, so
 * the approval card states the consequence rather than just the schedule. */
export function consequenceLine(schedule: RoutineRequestSchedule, continuity = false): string {
  // A continuity routine still gets a fresh session per run; what carries
  // over is the previous run's report, so say that rather than contradict
  // the Continuity line above it.
  const session = continuity ? "each run starts a fresh session with the previous run's report" : "each run starts a fresh session";
  if (schedule.type === "once") return "Will run once; that run starts a fresh session.";
  if (schedule.type === "interval") {
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
    schedule: { ...existing.schedule },
    runOn: existing.runOn,
    durationMinutes: existing.durationMinutes,
    ...(existing.timeoutMinutes === undefined ? {} : { timeoutMinutes: existing.timeoutMinutes }),
    ...(existing.continuity ? { continuity: true } : {}),
  };
  if (operation.action !== "update") return base;
  const { timeoutMinutes, ...changes } = operation.changes;
  const merged: RoutineRequestDefinition = { ...base, ...changes };
  if (timeoutMinutes === null) delete merged.timeoutMinutes;
  else if (timeoutMinutes !== undefined) merged.timeoutMinutes = timeoutMinutes;
  return merged;
}

function cardCopy(
  operation: RoutineRequestOperation,
  manager: RoutineManager,
  timeZone: string,
  now: number,
): RoutineCardCopy {
  const definition = effectiveDefinition(operation, manager);
  const actionCopy = ACTION_COPY[operation.action];
  const actionLabel = actionCopy.title;
  const name = redactSecretsInText(definition?.name ?? "routine");
  const forBot = operation.action === "create" ? operation.forBot : undefined;
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
  const nextRunAt = nextForOperation(operation, manager, now);
  const when = operation.action === "run_now" ? "Now" : scheduleText(definition.schedule, timeZone);
  const destination = definition.runOn === "cloud" ? "Cloud VM" : "This OpenMausBot setup";
  const current = operation.action === "create"
    ? null
    : manager.listRoutines().find((routine) => routine.id === operation.routineId) ?? null;
  const remainsPaused = operation.action === "update" && current?.enabled === false;
  const deferredInterval = definition.schedule.type === "interval" && definition.schedule.anchorAt === undefined;
  const nextDescription = remainsPaused
    ? "None — this routine remains paused"
    : deferredInterval
      ? "One interval after confirmation"
      : nextRunAt !== null
        ? formatInstant(nextRunAt, timeZone)
        : operation.action === "pause"
          ? "None — this routine will be paused"
          : operation.action === "delete"
            ? "None — this routine will be deleted"
            : "None";
  const status = remainsPaused ? " · Remains paused" : "";
  // Existing routines may predate nested-card redaction. The approval still
  // shows every instruction, but credential-shaped values never travel back
  // through the bot's MCP response or into the transcript.
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
      ...(forBot ? [`For: @${redactSecretsInText(forBot.name)} — each run uses that bot's engine and permissions`] : []),
      `Schedule: ${when}`,
      `Next run: ${nextDescription}`,
      `Runs on: ${destination}`,
      `Run limit: ${definition.timeoutMinutes === undefined ? "No limit" : `${definition.timeoutMinutes} minutes`}`,
      `Continuity: ${definition.continuity ? "Carries the previous run's report into the next run" : "Each run starts fresh"}`,
      // Last before the instructions: the one sentence that says what
      // confirming actually does, in the reader's terms.
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
  };
}

function updateFromChanges(changes: RoutineRequestChanges, now: number): Partial<RoutineInput> {
  const patch: Partial<RoutineInput> = {};
  if (changes.name !== undefined) patch.name = changes.name;
  if (changes.instructions !== undefined) patch.prompt = changes.instructions;
  if (changes.schedule !== undefined) patch.schedule = asSchedule(changes.schedule, now);
  if (changes.runOn !== undefined) patch.runOn = changes.runOn;
  if (changes.durationMinutes !== undefined) patch.durationMinutes = changes.durationMinutes;
  if (changes.timeoutMinutes !== undefined) patch.timeoutMinutes = changes.timeoutMinutes;
  if (changes.continuity !== undefined) patch.continuity = changes.continuity;
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

/** Bind exact-once recovery to the immutable card owner as well as its
 * operation. Recursive key sorting keeps old receipts valid if a future
 * schema refactor changes object construction order. */
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
  if (!current) throw new RoutineRequestError("That routine no longer exists", 404);
  if (current.updatedAt !== operation.expectedUpdatedAt) {
    throw new RoutineRequestError(
      "That routine changed after this confirmation card was prepared. Ask the bot to review it and propose the action again.",
      409,
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
  const current = operation.action === "create"
    ? null
    : verifyManageSnapshot(operation, manager, botId);
  const schedule = operation.action === "create"
    ? operation.routine.schedule
    : operation.action === "update"
      ? operation.changes.schedule
      : undefined;
  if (schedule?.type === "once" && schedule.at <= now) {
    throw new RoutineRequestError("That one-time schedule is now in the past. Ask the bot to propose a new time.", 409);
  }
  if (operation.action === "resume") {
    if (!current) throw new RoutineRequestError("That routine no longer exists", 404);
    if (nextOccurrence(current.schedule, now) === null) {
      throw new RoutineRequestError(
        "That one-time routine's scheduled time has passed. Update it to a new future time before resuming.",
        409,
      );
    }
  }
}

export class RoutineRequestService {
  private readonly store: RoutineRequestStore;
  private readonly routines: RoutineManager;
  private readonly now: () => number;
  private readonly timeZone: () => string;
  private readonly cloudReady?: () => Promise<{ ready: boolean; reason?: string }>;
  private readonly canPersist?: RoutineRequestServiceOptions["canPersist"];
  private readonly validateTarget?: RoutineRequestServiceOptions["validateTarget"];

  constructor(options: RoutineRequestServiceOptions) {
    this.store = options.store;
    this.routines = options.routines;
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    this.cloudReady = options.cloudReady;
    this.canPersist = options.canPersist;
    this.validateTarget = options.validateTarget;
  }

  async propose(args: ProposeRoutineRequestArgs): Promise<RoutineProposalResult> {
    const botId = text(args.botId, "botId", 128);
    const threadId = text(args.threadId, "threadId", 128);
    const at = this.now();
    const parsedProposal = routineProposalSchema.safeParse(args.proposal);
    if (!parsedProposal.success) {
      throw new RoutineRequestError(schemaIssue(parsedProposal.error, "Invalid routine proposal"));
    }
    const operation = normalizedOperation(this.routines, botId, parsedProposal.data, at);
    if (operation.action === "create" && operation.forBot && this.validateTarget) {
      const refusal = this.validateTarget(botId, operation.forBot);
      if (refusal) throw new RoutineRequestError(refusal, 403);
    }
    await this.requireCloudReadiness(operation);
    // The readiness probe is asynchronous. Another request can edit or
    // delete the routine while it is in flight, so re-check the captured
    // revision before rendering and persisting the confirmation snapshot.
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
    const timeZone = this.timeZone();
    const copy = cardCopy(operation, this.routines, timeZone, cardAt);
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
    // This check and append are deliberately adjacent and synchronous. JS
    // cannot interleave another completed proposal between the capacity /
    // ownership decision and the durable transcript write.
    const persistence = this.canPersist?.(botId, threadId);
    if (persistence && !persistence.ok) {
      throw new RoutineRequestError(persistence.error, persistence.status);
    }
    if (args.canCommit && !args.canCommit()) {
      throw new RoutineRequestError("The requesting turn ended before this proposal could be saved", 401);
    }
    const message = this.store.appendMessage(threadId, messageInput);
    return {
      requestId,
      messageId: message.id,
      title: copy.title,
      summary: copy.summary,
      detail: copy.detail,
      nextRunAt: copy.nextRunAt,
      timeZone,
    };
  }

  private async requireCloudReadiness(operation: RoutineRequestOperation): Promise<void> {
    if (!this.cloudReady || operation.action === "pause" || operation.action === "delete") return;
    const definition = effectiveDefinition(operation, this.routines);
    if (definition?.runOn !== "cloud") return;
    let readiness: { ready: boolean; reason?: string };
    try {
      readiness = await this.cloudReady();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RoutineRequestError(`Could not verify cloud readiness: ${detail}`, 503);
    }
    if (readiness.ready) return;
    throw new RoutineRequestError(
      readiness.reason?.trim() || "Cloud execution is not configured yet. Set up a cloud computer first.",
      409,
    );
  }

  /**
   * Claims a routine card even after it was settled. That distinction is
   * important: duplicate clicks must never fall through to a provider that
   * did not create the request id.
   */
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
      // Cancelling is always safe and must remain possible even if an older
      // persisted payload no longer passes today's schema. Otherwise that
      // durable card would own the composer forever with no escape hatch.
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
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      revalidateOperation(payload.operation, this.routines, payload.botId, this.now());
      if (payload.operation.action === "create" && payload.operation.forBot && this.validateTarget) {
        const refusal = this.validateTarget(payload.botId, payload.operation.forBot);
        if (refusal) throw new RoutineRequestError(refusal, 404);
      }
      const resultId = this.apply(payload, message.id, fingerprint);
      return this.settleApplied(args.threadId, message.id, card, payload, resultId);
    } catch (error) {
      const status = error instanceof RoutineRequestError ? error.status : 400;
      const detail = error instanceof Error ? error.message : String(error);
      this.store.patchMessage(args.threadId, message.id, {
        card: { ...card, held: redactSecretsInText(detail).slice(0, 500) },
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
      // The transcript is already durably settled. Retaining a redundant
      // receipt after a cleanup write failure is safe and a later duplicate
      // response will retry this cleanup.
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
        verifyManageSnapshot(operation, this.routines, payload.botId);
        const updated = this.routines.update(operation.routineId, updateFromChanges(operation.changes, confirmationAt), {
          requestId: payload.requestId,
          messageId,
          botId: payload.botId,
          threadId: payload.threadId,
          action: "update",
          fingerprintVersion: ROUTINE_REQUEST_FINGERPRINT_VERSION,
          fingerprint,
        });
        if (!updated) throw new RoutineRequestError("That routine no longer exists", 404);
        return updated.id;
      }
      case "pause":
      case "resume": {
        verifyManageSnapshot(operation, this.routines, payload.botId);
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
        verifyManageSnapshot(operation, this.routines, payload.botId);
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
        verifyManageSnapshot(operation, this.routines, payload.botId);
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
