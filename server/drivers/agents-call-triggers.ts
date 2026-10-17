// The trigger tools a bot uses from chat: list_triggers, list_trigger_events, create_trigger and manage_trigger. Every
// change applies at once (no confirmation card); the harness records it on the automation's card with Pause, Edit and Undo.
import { normalizeCronSchedule } from "../../shared/routine-schedule.ts";

import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import { WEEKDAYS } from "./agents-catalog.ts";
import type { Json } from "./agents-client.ts";

export const TRIGGER_TOOL_NAMES: ReadonlySet<string> = new Set(["list_triggers", "list_trigger_events", "create_trigger", "manage_trigger"]);

const LIST_ROUTE = "/api/internal/triggers";
const EVENTS_ROUTE = "/api/internal/trigger-events";
const APP_ONLY = ["app", "event", "account"] as const;
const REQUEST_ROUTE = "/api/internal/trigger-requests";
const SCHEDULE_ONLY = ["schedule", "timeout_minutes", "timeoutMinutes", "clear_timeout", "continuity", "overlap", "run_on_startup", "runOnStartup"] as const;

function jsonRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

interface NormalizedSchedule {
  schedule?: Json;
  error?: string;
}

/** Models stringify nested objects, say "daily" or shorten weekday names; each has one obvious meaning. */
function normalizeScheduleInput(args: Json): NormalizedSchedule {
  let raw = args.schedule;
  if (typeof raw === "string") {
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
  // Providers may send unused optional fields as null; any other unknown field refuses the call.
  const unsupported = fields && Object.keys(raw).find((key) => raw[key] != null && !fields.includes(key));
  if (unsupported) {
    return { error: `Unsupported ${type} schedule field "${unsupported}". Weekly and daily times use the computer's timezone from list_triggers. ${SUPPORTED_SCHEDULES}` };
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

type RoutineAction = "update" | "pause" | "resume" | "run_now" | "delete";

function routineAction(value: unknown): RoutineAction | null {
  return value === "update" || value === "pause" || value === "resume" || value === "run_now" || value === "delete"
    ? value
    : null;
}

function routineFields(args: Json): { fields: Json; error?: string } {
  const fields: Json = {};
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
    return { fields, error: 'Use run_on="maus" for the bot’s current model and configured computer (including VPS), or run_on="box" only for the bot’s cloud computer. Legacy "cloud" also means box.' };
  }
  if (timeoutMinutes != null && (
    typeof timeoutMinutes !== "number" || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 5 || timeoutMinutes > 240
  )) {
    return { fields, error: "timeout_minutes must be a whole number from 5 to 240. Use clear_timeout to remove a limit." };
  }
  if (args.continuity != null && typeof args.continuity !== "boolean") {
    return { fields, error: "continuity must be true or false." };
  }
  if (args.run_on_startup != null && args.runOnStartup != null && args.run_on_startup !== args.runOnStartup) {
    return { fields, error: "Choose one run_on_startup value; run_on_startup and runOnStartup disagree." };
  }
  const runOnStartup = args.run_on_startup ?? args.runOnStartup;
  if (runOnStartup != null && typeof runOnStartup !== "boolean") {
    return { fields, error: "run_on_startup must be true or false." };
  }
  if (args.overlap !== undefined && args.overlap !== "skip" && args.overlap !== "queue") {
    return { fields, error: "overlap must be skip or queue." };
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
  if (args.overlap !== undefined) fields.overlap = args.overlap;
  if (typeof runOnStartup === "boolean") fields.runOnStartup = runOnStartup;
  return { fields };
}


const FILTER_KEYS = { from: "from", subject_contains: "subject", label: "label", contains: "text" } as const;

/** The plain filter in its stored words; Gmail turns it into its own search, other apps match it on arrival. */
function appFilter(raw: unknown): { filter?: Json; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (!jsonRecord(raw)) return { error: 'filter must be an object such as {"from":"acme.com","subject_contains":"order"}.' };
  const filter: Json = {};
  for (const [key, value] of Object.entries(raw)) {
    const stored = FILTER_KEYS[key as keyof typeof FILTER_KEYS];
    if (!stored) return { error: `filter takes from, subject_contains, label and contains; not ${key}.` };
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > 200) return { error: `filter.${key} must be text of at most 200 characters.` };
    filter[stored] = value.trim();
  }
  return { filter };
}

/** Schedule fields plus the webhook's event types and the app event's filter and settings, normalized once; which apply
 *  is checked against the trigger's kind. */
function triggerFields(args: Json): { fields: Json; error?: string } {
  const { fields, error } = routineFields(args);
  if (error) return { fields, error };
  const { filter, error: filterError } = appFilter(args.filter);
  if (filterError) return { fields, error: filterError };
  if (filter) fields.filter = filter;
  if (args.event_config !== undefined && args.event_config !== null) {
    if (!jsonRecord(args.event_config)) return { fields, error: 'event_config must be an object of the event\'s settings from list_trigger_events, e.g. {"channel_id":"C0123"}.' };
    fields.config = args.event_config;
  }
  const eventTypes = args.webhook_event_types;
  if (eventTypes !== undefined && eventTypes !== null) {
    if (!Array.isArray(eventTypes) || eventTypes.some((value) => typeof value !== "string")) {
      return { fields, error: "webhook_event_types must be a list of event names." };
    }
    fields.eventTypes = eventTypes.map((value) => String(value).trim()).filter(Boolean);
  }
  return { fields };
}

function appliedText(r: Json, done: string): ToolCallResult {
  const summary = typeof r.summary === "string" && r.summary.trim() ? `\n\n${r.summary.trim()}` : "";
  const detail = typeof r.detail === "string" && r.detail.trim() ? `\n\n${r.detail.trim()}` : "";
  const id = typeof r.resultId === "string" ? r.resultId : jsonRecord(r.result) && typeof r.result.resultId === "string" ? r.result.resultId : "";
  const attention = r.settlementPending && typeof r.message === "string" ? `\n\nNeeds attention: ${r.message}`
    : jsonRecord(r.result) && typeof r.result.message === "string" ? `\n\nNeeds attention: ${r.result.message}` : "";
  return {
    text: `${done}${id ? ` (trigger id ${id})` : ""}. It applied at once; the person sees it on a card with Edit, Pause and Undo.${summary}${detail}${attention}\n\nDo not ask for confirmation. Tell the person in one sentence what will happen.`,
  };
}

async function request(body: Json, context: ToolCallContext, done: string): Promise<ToolCallResult> {
  const { ok, status, body: r } = await context.client.apiResponse(REQUEST_ROUTE, {
    method: "POST",
    body: JSON.stringify({ fromBotId: context.botId, fromThreadId: context.threadId, ...body }),
  });
  if (!ok) {
    const error = typeof r.error === "string" ? r.error : `HTTP ${status}`;
    return { text: `The trigger change did not apply: ${error}\n\nDo not claim it was applied. Fix what the error says, or tell the person plainly what is missing.`, isError: true };
  }
  return appliedText(r, done);
}

export async function callTriggerTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const forBotId = typeof args.for_bot_id === "string" && args.for_bot_id.trim() ? args.for_bot_id.trim() : undefined;
  if (name === "list_triggers") {
    const query = new URLSearchParams({ fromBotId: context.botId, fromThreadId: context.threadId });
    if (typeof args.trigger_id === "string" && args.trigger_id.trim()) query.set("triggerId", args.trigger_id.trim());
    if (forBotId) query.set("forBotId", forBotId);
    const r = await context.client.api(`${LIST_ROUTE}?${query.toString()}`);
    const now = typeof r.now === "string" ? r.now : new Date().toISOString();
    const timeZone = typeof r.timeZone === "string" && r.timeZone ? r.timeZone : "local computer timezone";
    const clock = `current time: ${now}; timezone: ${timeZone}`;
    if (typeof r.error === "string") return { text: `${r.error} (${clock})`, isError: true };
    if (r.trigger) return { text: `Trigger (${clock}):\n${JSON.stringify(r.trigger, null, 2)}` };
    const triggers = Array.isArray(r.triggers) ? r.triggers : [];
    if (!triggers.length) return { text: `This bot has no triggers. Current time: ${now}. Timezone: ${timeZone}.` };
    return { text: `This bot's triggers (${clock}):\n${JSON.stringify(triggers, null, 2)}` };
  }
  if (name === "list_trigger_events") {
    const query = new URLSearchParams({ fromBotId: context.botId, fromThreadId: context.threadId });
    if (typeof args.app === "string" && args.app.trim()) query.set("app", args.app.trim().toLowerCase());
    if (typeof args.search === "string" && args.search.trim()) query.set("search", args.search.trim().slice(0, 100));
    const r = await context.client.api(`${EVENTS_ROUTE}?${query.toString()}`);
    if (typeof r.error === "string") return { text: r.error, isError: true };
    if (typeof r.unavailable === "string") return { text: r.unavailable };
    const apps = Array.isArray(r.apps) ? r.apps : [];
    const notConnected = Array.isArray(r.notConnected) ? r.notConnected : [];
    const connect = notConnected.length
      ? `\n\nNot connected yet: ${notConnected.map((app) => jsonRecord(app) ? String(app.name) : "").filter(Boolean).join(", ")}. If the person wants one of these, ask them to connect it (call COMPOSIO_MANAGE_CONNECTIONS for that app if you have it; otherwise they connect it under Connected apps), then call list_trigger_events again and create the trigger.`
      : "";
    if (!apps.length) return { text: `No connected app this bot may use offers events.${connect}` };
    return {
      text: `Events you can watch (delivery "poll" checks every 15 minutes; "instant" arrives at once). Filter at the source with filter for Gmail; put other required settings in event_config:\n${JSON.stringify(apps, null, 2)}${connect}`,
    };
  }
  if (name === "create_trigger") {
    const when = args.when;
    if (when !== "schedule" && when !== "webhook" && when !== "app_event") return { text: 'create_trigger needs when: "schedule", "app_event" or "webhook".', isError: true };
    const { fields, error } = triggerFields(args);
    if (error) return { text: error, isError: true };
    if (!fields.name || !fields.instructions) return { text: "create_trigger needs name and instructions.", isError: true };
    if (when !== "app_event") {
      const appOnly = [...APP_ONLY, "filter", "event_config"].find((key) => args[key] !== undefined && args[key] !== null);
      if (appOnly) return { text: `${appOnly} applies only to when=app_event.`, isError: true };
    }
    if (when === "app_event") {
      const misplaced = [...SCHEDULE_ONLY, "webhook_event_types"].find((key) => args[key] !== undefined && args[key] !== null);
      if (misplaced) return { text: `An app-event trigger fires when the app's event happens, so it takes no ${misplaced}.`, isError: true };
      const app = typeof args.app === "string" ? args.app.trim().toLowerCase() : "";
      const event = typeof args.event === "string" ? args.event.trim() : "";
      if (!app || !event) return { text: "An app_event trigger needs app and event from list_trigger_events. Call list_trigger_events first.", isError: true };
      const trigger = {
        name: fields.name, instructions: fields.instructions, app, event,
        ...(typeof args.account === "string" && args.account.trim() ? { account: args.account.trim() } : {}),
        ...(fields.filter ? { filter: fields.filter } : {}), ...(fields.config ? { config: fields.config } : {}), ...(fields.runOn ? { runOn: fields.runOn } : {}),
      };
      return request({ action: "create", kind: "app", trigger, ...(forBotId ? { forBotId } : {}) }, context, `Created the app-event trigger “${String(fields.name)}”`);
    }
    const label = `the ${when === "webhook" ? "webhook" : "schedule"} trigger “${String(fields.name)}”`;
    if (when === "schedule") {
      if (!fields.schedule) return { text: "A schedule trigger needs schedule.", isError: true };
      if (fields.eventTypes) return { text: "webhook_event_types applies only to when=webhook.", isError: true };
      const { eventTypes: _unused, ...routine } = fields;
      return request({ action: "create", kind: "schedule", routine, ...(forBotId ? { forBotId } : {}) }, context, `Created ${label}`);
    }
    const misplaced = SCHEDULE_ONLY.find((key) => args[key] !== undefined && args[key] !== null);
    if (misplaced) return { text: `A webhook trigger fires when its link is called, so it takes no ${misplaced}.`, isError: true };
    const webhook = { name: fields.name, instructions: fields.instructions, ...(fields.runOn ? { runOn: fields.runOn } : {}), ...(fields.eventTypes ? { eventTypes: fields.eventTypes } : {}) };
    return request({ action: "create", kind: "webhook", webhook, ...(forBotId ? { forBotId } : {}) }, context, `Created ${label}`);
  }
  const triggerId = typeof args.trigger_id === "string" ? args.trigger_id.trim() : "";
  const action = routineAction(args.action);
  if (!triggerId || !action) return { text: "manage_trigger needs a trigger_id from list_triggers and an action.", isError: true };
  const body: Json = { action, triggerId, ...(forBotId ? { forBotId } : {}) };
  if (action === "update") {
    if (!jsonRecord(args.changes)) return { text: "The update action needs at least one field in changes.", isError: true };
    const { fields, error } = triggerFields(args.changes);
    if (error) return { text: error, isError: true };
    if (!Object.keys(fields).length) return { text: "The update action needs at least one supported field in changes.", isError: true };
    body.changes = fields;
  } else if (args.changes !== undefined) {
    return { text: `The ${action} action does not accept changes.`, isError: true };
  }
  const done = action === "run_now" ? `Started trigger ${triggerId} once now` : `Applied ${action} to trigger ${triggerId}`;
  return request(body, context, done);
}
