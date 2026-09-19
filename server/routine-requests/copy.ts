// Routine request card copy and fingerprints — schedule/consequence text,
// the approval card renderer, stored-input builders, and the exact-once
// receipt fingerprint.

import { createHash } from "node:crypto";

import { cronScheduleLabel } from "../../shared/cron-label.ts";
import { nextCronRuns } from "../../shared/routine-schedule.ts";
import type {
  RoutineInput,
  RoutineManager,
  RoutineSchedule,
} from "../routines.ts";
import { parseJson, type JsonObject, type JsonValue } from "../schema.ts";
import { redactSecretsInText } from "../redact.ts";
import type {
  RoutineRequestCardData,
  RoutineRequestChanges,
  RoutineRequestDefinition,
  RoutineRequestOperation,
  RoutineRequestSchedule,
} from "../../shared/routine-request.ts";
import { jsonObjectSchema } from "./schemas.ts";
import {
  asSchedule,
  effectiveDefinition,
  formatInstant,
  intervalHasRestrictions,
  nextForOperation,
  schedulePatch,
} from "./normalize.ts";

const WEEKDAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ACTION_COPY = {
  create: { title: "Schedule", detail: "Create routine" },
  update: { title: "Update", detail: "Update routine" },
  pause: { title: "Pause", detail: "Pause routine" },
  resume: { title: "Resume", detail: "Resume routine" },
  run_now: { title: "Run now", detail: "Run routine now" },
  delete: { title: "Delete", detail: "Delete routine" },
} as const satisfies Record<RoutineRequestOperation["action"], { title: string; detail: string }>;
export const ROUTINE_REQUEST_FINGERPRINT_VERSION = 1 as const;
interface RoutineCardCopy {
  title: string;
  summary: string;
  detail: string;
  nextRunAt: number | null;
  tool: "schedule_routine" | "manage_routine";
}
export function scheduleText(schedule: RoutineRequestSchedule, timeZone: string): string {
  if (schedule.type === "cron") return `${cronScheduleLabel(schedule)} · Cron: ${schedule.expression}`;
  if (schedule.type === "once") return `${formatInstant(schedule.at, timeZone)} (${timeZone})`;
  if (schedule.type === "interval") {
    const restricted = intervalHasRestrictions(schedule);
    const cadence = schedule.anchorAt === undefined
      ? restricted
        ? `Every ${schedule.everyMinutes} minutes, cadence starting at confirmation; first run is the next allowed time`
        : `Every ${schedule.everyMinutes} minutes, starting one interval after confirmation`
      : `Every ${schedule.everyMinutes} minutes, anchored at ${formatInstant(schedule.anchorAt, timeZone)} (${timeZone})`;
    const restrictions = [
      schedule.weekdays?.length
        ? `on ${schedule.weekdays.map((day) => WEEKDAY_LABEL[day]).join(", ")} (${timeZone})`
        : null,
      schedule.window ? `during ${schedule.window.start}–${schedule.window.end} (${timeZone})` : null,
      schedule.endsAt !== undefined ? `until ${formatInstant(schedule.endsAt, timeZone)} (${timeZone})` : null,
    ].filter((part): part is string => part !== null);
    return restrictions.length ? `${cadence} · ${restrictions.join(" · ")}` : cadence;
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
  if (schedule.type === "cron") return `Will run at matching calendar times in ${schedule.timeZone}; ${session}.`;
  if (schedule.type === "once") return "Will run once; that run starts a fresh session.";
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
export function cardCopy(
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
  const scheduleTimeZone = definition.schedule.type === "cron" ? definition.schedule.timeZone : timeZone;
  const when = operation.action === "run_now" ? "Now" : scheduleText(definition.schedule, timeZone);
  const destination = definition.runOn === "cloud" ? "Box-hosted agent" : "Bot’s current model and configured computer";
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
        ? `Next allowed time after confirmation (${timeZone})`
        : "One interval after confirmation"
      : nextRunAt !== null
        ? formatInstant(nextRunAt, scheduleTimeZone)
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
      ...(definition.schedule.type === "cron" && nextRunAt !== null && operation.action !== "run_now"
        ? [`Next 3 runs (${scheduleTimeZone}): ${nextCronRuns(definition.schedule, now, 3).map((at) => formatInstant(at, scheduleTimeZone)).join(" · ")}`]
        : []),
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

export function inputFromDefinition(definition: RoutineRequestDefinition, botId: string, now: number): RoutineInput {
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

export function updateFromChanges(
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
