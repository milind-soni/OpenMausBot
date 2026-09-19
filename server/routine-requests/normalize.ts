// Routine request pure helpers — validation and normalization of proposals
// into stored operations, schedule conversion and merge math. No I/O;
// everything here is deterministic given its arguments.

import { normalizeCronSchedule } from "../../shared/routine-schedule.ts";
import { redactSecretsInText } from "../redact.ts";
import {
  nextOccurrence,
  type Routine,
  type RoutineManager,
  type RoutineSchedule,
  type RoutineScheduleInput,
} from "../routines.ts";
import type {
  RoutineRequestChanges,
  RoutineRequestDefinition,
  RoutineRequestOperation,
  RoutineRequestRunOn,
  RoutineRequestSchedule,
  RoutineRequestScheduleChanges,
} from "../../shared/routine-request.ts";
import { RoutineRequestError } from "./types.ts";
import {
  MAX_DATE_MS,
  ROUTINE_ID,
  TIME,
  intervalWindowMinutes,
  type ParsedRoutineProposal,
  type RoutineToolChangesInput,
  type RoutineToolDefinitionInput,
  type RoutineToolScheduleInput,
} from "./schemas.ts";

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
export function text(value: string, field: string, max: number): string {
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

function normalizeSchedule(schedule: RoutineToolScheduleInput, now: number): RoutineRequestSchedule {
  if (schedule.type === "cron") {
    try {
      return normalizeCronSchedule(schedule, now);
    } catch (error) {
      throw new RoutineRequestError(error instanceof Error ? error.message : "Invalid cron schedule");
    }
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
    // SAFETY: every key in WEEKDAY_NUMBER is lower-case; membership is
    // checked immediately below before the numeric value is retained.
    const number = WEEKDAY_NUMBER[day.toLowerCase() as keyof typeof WEEKDAY_NUMBER];
    if (number === undefined) throw new RoutineRequestError(`Unsupported weekday: ${day}`);
    return number;
  });
  return { type: "daily", time: schedule.time, weekdays: [...new Set(weekdays)].sort() };
}

function normalizeScheduleChanges(
  schedule: RoutineToolScheduleInput,
  now: number,
): RoutineRequestScheduleChanges {
  const normalized = normalizeSchedule(schedule, now);
  if (schedule.type !== "interval" || normalized.type !== "interval") return normalized;
  return {
    ...normalized,
    ...(schedule.weekdays === null ? { weekdays: null } : {}),
    ...(schedule.window === null ? { window: null } : {}),
    ...(schedule.endsAt === null ? { endsAt: null } : {}),
  };
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
  if (input.schedule !== undefined) changes.schedule = normalizeScheduleChanges(input.schedule, now);
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

export function ownedRoutine(manager: RoutineManager, id: string, botId: string): Routine | null {
  return manager.listRoutines().find((routine) => routine.id === id && routine.botId === botId) ?? null;
}

export function noFutureResumeMessage(schedule: RoutineSchedule): string {
  if (schedule.type === "interval") {
    return "That interval routine has no future runs. Choose a later end time or remove the end restriction before resuming.";
  }
  if (schedule.type === "once") {
    return "That one-time routine's scheduled time has passed. Update it to a new future time before resuming.";
  }
  return "That routine has no future runs. Update its schedule before resuming.";
}

export function normalizedOperation(
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
    throw new RoutineRequestError(noFutureResumeMessage(current.schedule), 409);
  }
  return { action: validated.action, routineId: id, expectedUpdatedAt: current.updatedAt };
}

export function asSchedule(schedule: RoutineRequestSchedule, now: number): RoutineSchedule {
  if (schedule.type === "cron") return { ...schedule };
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

export function schedulePatch(
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

export function effectiveSchedule(
  current: RoutineRequestSchedule,
  incoming: RoutineRequestScheduleChanges,
): RoutineRequestSchedule {
  if (incoming.type === "cron") return { ...incoming };
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

export function nextForOperation(operation: RoutineRequestOperation, manager: RoutineManager, now: number): number | null {
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

export function formatInstant(at: number, timeZone: string): string {
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

export function intervalHasRestrictions(
  schedule: Extract<RoutineRequestSchedule, { type: "interval" }>,
): boolean {
  return schedule.weekdays !== undefined || schedule.window !== undefined || schedule.endsAt !== undefined;
}
export function effectiveDefinition(operation: RoutineRequestOperation, manager: RoutineManager): RoutineRequestDefinition | null {
  if (operation.action === "create") return operation.routine;
  const existing = manager.listRoutines().find((routine) => routine.id === operation.routineId);
  if (!existing) return null;
  const base: RoutineRequestDefinition = {
    name: existing.name,
    instructions: existing.prompt,
    schedule: existing.schedule.type === "interval"
      ? {
          ...existing.schedule,
          ...(existing.schedule.weekdays ? { weekdays: [...existing.schedule.weekdays] } : {}),
          ...(existing.schedule.window ? { window: { ...existing.schedule.window } } : {}),
        }
      : existing.schedule.type === "daily"
        ? { ...existing.schedule, weekdays: [...existing.schedule.weekdays] }
        : { ...existing.schedule },
    runOn: existing.runOn,
    durationMinutes: existing.durationMinutes,
    ...(existing.timeoutMinutes === undefined ? {} : { timeoutMinutes: existing.timeoutMinutes }),
    ...(existing.continuity ? { continuity: true } : {}),
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
  return merged;
}
