// The model-facing routine schemas and the input coercion behind the
// propose_* routine tools: ROUTINE_FIELDS_SCHEMA is spread into the tool
// table entries in agents-proxy.ts, routineFields runs (via ToolContext)
// inside the routine handlers, and everything else is private to this
// module. Kept as a sibling of routines.ts so the schedule dialect rules
// live beside the tools that enforce them.
import { normalizeCronSchedule } from "../../../shared/routine-schedule.ts";
import type { Json } from "./context.ts";
import { jsonRecord } from "./helpers.ts";

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

// One flat object, deliberately free of oneOf/const/format: several agent
// CLIs flatten or drop JSON-Schema composition keywords when converting MCP
// tools into their provider's function-call format, and a model that never
// saw the branches guesses shapes forever (the 0.1.38 field failure). The
// per-type rules live in descriptions and are enforced with guiding errors
// in normalizeScheduleInput below.
const ROUTINE_SCHEDULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    'Use {"type":"cron","expression":"0 9 1 * *","timeZone":"Asia/Kolkata"} for 09:00 on the first of each month, once with at for one future run, weekly with time + weekdays, daily with time, or interval with every_minutes for elapsed-time repetition. Intervals can optionally be limited with weekdays, window_start + window_end, and ends_at.',
  properties: {
    type: {
      type: "string",
      enum: ["once", "weekly", "daily", "interval", "cron"],
      description: "once = a single future run; weekly = chosen weekdays; daily = every day; interval = every N elapsed minutes; cron = a calendar rule in an explicit timezone.",
    },
    expression: {
      type: "string",
      maxLength: 256,
      description: "Only for cron: five fields, minute hour day-of-month month weekday. Examples: 0 9 1 * * = monthly on day 1 at 09:00; 0 9 L * * = last day of each month; 0 9 * * MON#2 = second Monday of each month. Lists, ranges and steps are supported. No seconds, year, or @ macros. Never substitute daily AI date checks for a calendar rule.",
    },
    timeZone: {
      type: "string",
      maxLength: 128,
      description: "Required for cron: explicit IANA timezone, for example Asia/Kolkata, America/New_York, or UTC. Use the user's requested zone; resolve ambiguity before proposing. Do not send a numeric offset or local-time abbreviation.",
    },
    at: {
      type: "string",
      description:
        "Only for type once: future RFC3339 date-time with an explicit timezone offset, for example 2026-09-01T09:00:00+05:30 or 2026-09-01T03:30:00Z.",
    },
    time: {
      type: "string",
      description: "For type weekly or daily: local computer time in 24-hour HH:MM format, for example 09:00.",
    },
    weekdays: {
      type: "array",
      items: { type: "string", enum: WEEKDAYS },
      description:
        "For type weekly: required run days. For type interval: optional allowed days. Values use the computer's local timezone.",
    },
    every_minutes: {
      type: "integer",
      minimum: 5,
      maximum: 1_440,
      description: "Only for type interval: whole minutes between runs, from 5 to 1440.",
    },
    starts_at: {
      type: "string",
      description:
        "Optional for type interval: RFC3339 date-time with an explicit timezone offset that anchors the cadence. Omit to start one interval after the routine is applied (immediately with granted Full Access, otherwise after confirmation).",
    },
    window_start: {
      type: "string",
      description:
        "Optional for type interval, together with window_end: local 24-hour HH:MM when runs may begin, inclusive.",
    },
    window_end: {
      type: "string",
      description:
        "Optional for type interval, together with window_start: local 24-hour HH:MM when the allowed window ends, exclusive. It must be later on the same day.",
    },
    ends_at: {
      type: "string",
      description:
        "Optional for type interval: inclusive RFC3339 date-time cutoff with an explicit timezone offset.",
    },
    every_day: {
      type: "boolean",
      description: "Only for an interval update: true removes an existing weekday restriction.",
    },
    all_day: {
      type: "boolean",
      description: "Only for an interval update: true removes an existing time-window restriction.",
    },
    never_ends: {
      type: "boolean",
      description: "Only for an interval update: true removes an existing end cutoff.",
    },
  },
  required: ["type"],
} as const;

const SHORT_WEEKDAYS = {
  mon: "monday",
  tue: "tuesday",
  tues: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
} as const satisfies Record<string, (typeof WEEKDAYS)[number]>;

const SUPPORTED_SCHEDULES =
  'Supported schedules: {"type":"once","at":"2026-09-01T09:00:00+05:30"} (future RFC3339 with explicit offset), ' +
  '{"type":"weekly","time":"09:00","weekdays":["monday","friday"]}, {"type":"daily","time":"09:00"}, ' +
  '{"type":"interval","every_minutes":15,"weekdays":["monday","friday"],"window_start":"09:00","window_end":"17:00"}, ' +
  'or {"type":"cron","expression":"0 9 1 * *","timeZone":"Asia/Kolkata"} (monthly at 09:00 on day 1; five fields and an explicit IANA timezone).';

/** The outcome of coercing a model-sent schedule: the harness-dialect
 * schedule, or a message telling the model exactly what to send instead. */
interface NormalizedSchedule {
  schedule?: Json;
  error?: string;
}

/** A schedule as the harness accepts it, or a message telling the model
 * exactly what to send instead. Coercion first, error second: models
 * routinely stringify nested objects, say "daily", or shorten weekday
 * names, and each of those has one obvious meaning. */
function normalizeScheduleInput(args: Json): NormalizedSchedule {
  let raw = args.schedule;
  if (typeof raw === "string") {
    // Some models deliver nested objects as JSON strings.
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: `The schedule must be a JSON object, not text. ${SUPPORTED_SCHEDULES}` };
    }
  }
  if (!jsonRecord(raw)) return { error: `The schedule must be a JSON object. ${SUPPORTED_SCHEDULES}` };
  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  const fields = type === "once"
    ? ["type", "at"]
    : type === "weekly" || type === "daily"
      ? ["type", "time", "weekdays"]
      : type === "interval"
        ? ["type", "every_minutes", "everyMinutes", "starts_at", "anchorAt", "weekdays", "every_day", "window_start", "window_end", "window", "all_day", "ends_at", "endsAt", "never_ends"]
        : type === "cron"
          ? ["type", "expression", "timeZone"]
          : null;
  // Provider conversions may send unused optional fields as null. Ignore
  // those, but never silently discard an actual scheduling constraint (for
  // example timezone or a misspelled starts_at) and approve different work.
  const unsupported = fields && Object.keys(raw).find((key) => raw[key] != null && !fields.includes(key));
  if (unsupported) {
    return { error: `Unsupported ${type} schedule field "${unsupported}". Weekly and daily times use the computer's timezone from list_routines. ${SUPPORTED_SCHEDULES}` };
  }
  if (type === "cron") {
    try {
      return { schedule: { ...normalizeCronSchedule({ type, expression: raw.expression, timeZone: raw.timeZone }) } };
    } catch (error) {
      return { error: `${error instanceof Error ? error.message : "Invalid cron schedule"}. ${SUPPORTED_SCHEDULES}` };
    }
  }
  if (type === "once") {
    if (typeof raw.at !== "string" || !raw.at.trim()) {
      return { error: `A once schedule needs "at": a future RFC3339 date-time with an explicit offset, for example 2026-09-01T09:00:00+05:30.` };
    }
    return { schedule: { type: "once", at: raw.at.trim() } };
  }
  if (type === "weekly" || type === "daily") {
    const time = typeof raw.time === "string" ? raw.time.trim() : "";
    if (!time) return { error: `A ${type} schedule needs "time" in 24-hour HH:MM, for example 09:00.` };
    let weekdays: string[];
    if (type === "daily") {
      // daily = weekly on all seven days; an explicit weekdays list narrows it.
      weekdays = Array.isArray(raw.weekdays) && raw.weekdays.length ? raw.weekdays : [...WEEKDAYS];
    } else {
      if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0) {
        return { error: `A weekly schedule needs "weekdays", for example ["monday","friday"] — or use {"type":"daily"} to run every day.` };
      }
      weekdays = raw.weekdays;
    }
    const normalized: string[] = [];
    for (const day of weekdays) {
      const lower = String(day).trim().toLowerCase();
      const full = (WEEKDAYS as readonly string[]).includes(lower)
        ? lower
        : Object.hasOwn(SHORT_WEEKDAYS, lower)
          ? SHORT_WEEKDAYS[lower as keyof typeof SHORT_WEEKDAYS]
          : undefined;
      if (!full) return { error: `Unsupported weekday "${String(day)}". Use full names: ${WEEKDAYS.join(", ")}.` };
      if (!normalized.includes(full)) normalized.push(full);
    }
    return { schedule: { type: "weekly", time, weekdays: normalized } };
  }
  if (type === "interval") {
    for (const flag of ["every_day", "all_day", "never_ends"]) {
      if (raw[flag] != null && typeof raw[flag] !== "boolean") {
        return { error: `"${flag}" must be true or false.` };
      }
    }
    if (raw.window != null && (!jsonRecord(raw.window)
      || Object.keys(raw.window).some((key) => key !== "start" && key !== "end")
      || typeof raw.window.start !== "string" || typeof raw.window.end !== "string")) {
      return { error: '"window" must contain "start" and "end" in HH:MM, for example {"start":"09:00","end":"17:00"}.' };
    }
    const rawMinutes = raw.every_minutes ?? raw.everyMinutes;
    const everyMinutes = Number(rawMinutes);
    if (!Number.isInteger(everyMinutes) || everyMinutes < 5 || everyMinutes > 1_440) {
      return { error: 'An interval schedule needs "every_minutes": a whole number from 5 to 1440.' };
    }
    const rawStart = raw.starts_at ?? raw.anchorAt;
    if (rawStart !== undefined && (typeof rawStart !== "string" || !rawStart.trim())) {
      return { error: '"starts_at" must be an RFC3339 date-time with an explicit timezone offset.' };
    }
    if (raw.every_day === true && Array.isArray(raw.weekdays) && raw.weekdays.length > 0) {
      return { error: 'Choose interval "weekdays" or "every_day", not both.' };
    }
    let intervalWeekdays: string[] | null | undefined;
    if (raw.every_day === true) {
      intervalWeekdays = null;
    } else if (raw.weekdays !== undefined) {
      if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0) {
        return { error: 'Interval "weekdays" must contain at least one full weekday name.' };
      }
      intervalWeekdays = [];
      for (const day of raw.weekdays) {
        const lower = String(day).trim().toLowerCase();
        const full = (WEEKDAYS as readonly string[]).includes(lower)
          ? lower
          : Object.hasOwn(SHORT_WEEKDAYS, lower)
            ? SHORT_WEEKDAYS[lower as keyof typeof SHORT_WEEKDAYS]
            : undefined;
        if (!full) return { error: `Unsupported weekday "${String(day)}". Use full names: ${WEEKDAYS.join(", ")}.` };
        if (!intervalWeekdays.includes(full)) intervalWeekdays.push(full);
      }
    }
    const rawWindow = jsonRecord(raw.window) ? raw.window : undefined;
    const windowStart = raw.window_start ?? rawWindow?.start;
    const windowEnd = raw.window_end ?? rawWindow?.end;
    if (raw.all_day === true && (windowStart !== undefined || windowEnd !== undefined)) {
      return { error: 'Choose window_start + window_end or "all_day", not both.' };
    }
    let window: Json | null | undefined;
    if (raw.all_day === true) {
      window = null;
    } else if (windowStart !== undefined || windowEnd !== undefined) {
      if (typeof windowStart !== "string" || !windowStart.trim() || typeof windowEnd !== "string" || !windowEnd.trim()) {
        return { error: 'An interval time window needs both "window_start" and "window_end" in 24-hour HH:MM.' };
      }
      window = { start: windowStart.trim(), end: windowEnd.trim() };
    }
    const rawEnd = raw.ends_at ?? raw.endsAt;
    if (raw.never_ends === true && rawEnd !== undefined) {
      return { error: 'Choose "ends_at" or "never_ends", not both.' };
    }
    let endsAt: string | null | undefined;
    if (raw.never_ends === true) endsAt = null;
    else if (rawEnd !== undefined) {
      if (typeof rawEnd !== "string" || !rawEnd.trim()) {
        return { error: '"ends_at" must be an RFC3339 date-time with an explicit timezone offset.' };
      }
      endsAt = rawEnd.trim();
    }
    return {
      schedule: {
        type: "interval",
        everyMinutes,
        ...(typeof rawStart === "string" ? { anchorAt: rawStart.trim() } : {}),
        ...(intervalWeekdays !== undefined ? { weekdays: intervalWeekdays } : {}),
        ...(window !== undefined ? { window } : {}),
        ...(endsAt !== undefined ? { endsAt } : {}),
      },
    };
  }
  if (type === "hourly" || type === "minutes") {
    return { error: `Use an interval schedule for every-N-minutes work. ${SUPPORTED_SCHEDULES}` };
  }
  return { error: `Unknown schedule type "${type || "(missing)"}". ${SUPPORTED_SCHEDULES}` };
}

export const ROUTINE_FIELDS_SCHEMA = {
  name: { type: "string", minLength: 1, maxLength: 80, description: "Short name shown in Routines." },
  instructions: {
    type: "string",
    minLength: 1,
    maxLength: 20_000,
    description: "The complete instructions the bot should follow each time the routine runs.",
  },
  schedule: ROUTINE_SCHEDULE_SCHEMA,
  run_on: {
    type: "string",
    enum: ["maus", "box"],
    description: "Default maus keeps the bot's selected model and configured computer, INCLUDING a self-hosted VPS. Omit this field for normal schedules. box explicitly switches the agent to the Box-hosted runner; it requires Box setup and is not the generic cloud/VPS option. Legacy cloud values from list_routines mean box, not VPS.",
  },
  timeout_minutes: {
    type: "integer",
    minimum: 5,
    maximum: 240,
    description:
      "Optional safety limit for active work, from 5 to 240 minutes. Omit for no limit.",
  },
  clear_timeout: {
    type: "boolean",
    description: "Only for updates: set true to remove an existing safety limit. Do not combine with timeout_minutes.",
  },
  continuity: {
    type: "boolean",
    description: "Opt in to using the latest completed run's bounded report as historical context. Defaults to false; set false in an update to start fresh again. Included in the applied result or pending confirmation.",
  },
} as const;

export function routineFields(args: Json): { fields: Json; error?: string } {
  const fields: Json = {};
  // list_routines returns the harness names. Accept those when a model
  // copies back a definition, as we already do for interval fields.
  const destination = (value: unknown) => value === "box" ? "cloud" : value;
  if (args.run_on != null && args.runOn != null && destination(args.run_on) !== destination(args.runOn)) {
    return { fields, error: "Choose one run_on destination; run_on and runOn disagree." };
  }
  if (args.timeout_minutes != null && args.timeoutMinutes != null && args.timeout_minutes !== args.timeoutMinutes) {
    return { fields, error: "Choose one timeout_minutes limit; timeout_minutes and timeoutMinutes disagree." };
  }
  const runOn = destination(args.run_on ?? args.runOn);
  const timeoutMinutes = args.timeout_minutes ?? args.timeoutMinutes;
  if (runOn != null && runOn !== "maus" && runOn !== "cloud") {
    return { fields, error: 'Use run_on="maus" for the bot’s current model and configured computer (including VPS), or run_on="box" only for the Box-hosted agent. Legacy "cloud" also means Box.' };
  }
  if (timeoutMinutes != null && (
    typeof timeoutMinutes !== "number" || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 5 || timeoutMinutes > 240
  )) {
    return { fields, error: "timeout_minutes must be a whole number from 5 to 240. Use clear_timeout to remove a limit." };
  }
  if (args.continuity != null && typeof args.continuity !== "boolean") {
    return { fields, error: "continuity must be true or false." };
  }
  if (args.clear_timeout != null && typeof args.clear_timeout !== "boolean") {
    return { fields, error: "clear_timeout must be true or false." };
  }
  if (args.clear_timeout === true && timeoutMinutes != null) {
    return { fields, error: "Choose timeout_minutes or clear_timeout, not both." };
  }
  if (typeof args.name === "string") fields.name = args.name.trim();
  if (typeof args.instructions === "string") fields.instructions = args.instructions.trim();
  if (args.schedule !== undefined && args.schedule !== null) {
    const normalized = normalizeScheduleInput(args);
    if (normalized.error) return { fields, error: normalized.error };
    fields.schedule = normalized.schedule;
  }
  if (runOn != null) fields.runOn = runOn;
  if (args.clear_timeout === true) fields.timeoutMinutes = null;
  else if (timeoutMinutes != null) fields.timeoutMinutes = timeoutMinutes;
  if (typeof args.continuity === "boolean") fields.continuity = args.continuity;
  return { fields };
}
