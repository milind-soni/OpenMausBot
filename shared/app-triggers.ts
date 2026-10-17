/** App-event automations: "when something happens in a connected app, a bot does something". Wire shapes for the
 * REST snapshot (`/api/app-triggers`), the `app-trigger*` live frames and the chat card a bot's change leaves. */
import type { ConnectorToolGrant } from "./wire.ts";
import type { RoutineRunOn } from "./routines.ts";

/** Plain words a person or bot gives. Gmail turns them into its own search, so other mail never arrives at all; other
 * apps match them, case-insensitively, against the event's fields. */
export interface AppTriggerFilter {
  from?: string;
  /** The subject (or title) contains this. */
  subject?: string;
  label?: string;
  /** Anywhere in the event. */
  text?: string;
}

/** "instant": the app pushes each event; "poll": Composio checks on its interval (15 minutes on managed sign-ins). */
export type AppTriggerDelivery = "instant" | "poll";

export type AppTriggerProblem =
  | { kind: "reconnect"; at: number }
  | { kind: "error"; text: string; at: number };

/** Events Composio sent but the connected-apps service did not keep, today (UTC, as the service counts its limit). */
export interface AppTriggerSkipped {
  day: string;
  dailyLimit: number;
  queueFull: number;
  expired: number;
  /** Kept back here because this automation already had its limit of waiting runs. */
  tooMany: number;
}

export interface AppTrigger {
  id: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  /** Composio toolkit slug, e.g. `gmail`. */
  app: string;
  appName: string;
  /** Composio trigger type slug, e.g. `GMAIL_NEW_GMAIL_MESSAGE`. */
  event: string;
  eventName: string;
  delivery: AppTriggerDelivery;
  accountId: string;
  accountLabel?: string;
  /** Composio trigger config, with a Gmail filter already folded into `query`. */
  config: Record<string, unknown>;
  filter?: AppTriggerFilter;
  /** The connected-apps service's copy. `pending` is retried on its own until it holds. */
  remote: { triggerId?: string; state: "active" | "pending" | "error"; error?: string; syncedAt?: number };
  problem?: AppTriggerProblem;
  sourceThreadId?: string;
  /** Events that started a run or joined one. */
  received: number;
  filtered: number;
  skipped?: AppTriggerSkipped;
  lastEventAt?: number;
  lastRunId?: string;
  createdAt: number;
  updatedAt: number;
}

export type AppEventOutcome = "started" | "joined" | "filtered" | "duplicate" | "skipped" | "rejected";

export interface AppEventAttempt {
  id: string;
  triggerId: string;
  eventId: string;
  at: number;
  outcome: AppEventOutcome;
  reason?: string;
  runId?: string;
  /** One line: who it is from and what it is about, when the event says. */
  preview?: string;
}

export interface AppTriggerService {
  /** "self-hosted": this server uses its own Composio key, which app events do not support. */
  available: boolean;
  reason?: "self-hosted" | "unavailable";
  plan?: "desktop" | "cloud";
  eventsPerDay?: number;
  eventsToday?: number;
}

export interface AppTriggersSnapshot {
  triggers: AppTrigger[];
  attempts: AppEventAttempt[];
  service: AppTriggerService;
}

/** One event type a connected app offers, as the picker and `list_trigger_events` show it. */
export interface AppEventType {
  event: string;
  name: string;
  description: string;
  delivery: AppTriggerDelivery;
  configFields: Array<{ name: string; type: string; required: boolean; description?: string; default?: unknown }>;
  filterFields: string[];
}

export interface AppEventCatalog {
  apps: Array<{ app: string; name: string; accounts: Array<{ id: string; alias?: string }>; events: AppEventType[]; error?: string }>;
  /** Popular apps with events that are not connected yet. */
  notConnected: Array<{ app: string; name: string }>;
  unavailable?: string;
}

export interface AppTriggerDefinition {
  name: string;
  instructions: string;
  app: string;
  event: string;
  /** Connected account id or alias; needed only when the person has more than one for this app. */
  account?: string;
  filter?: AppTriggerFilter;
  config?: Record<string, unknown>;
  runOn?: RoutineRunOn;
}

export type AppTriggerChange = Partial<Pick<AppTriggerDefinition, "name" | "instructions" | "filter" | "config" | "runOn">>;

export type AppTriggerRequestOperation =
  | { action: "create"; trigger: AppTriggerDefinition; forBot?: { botId: string; name: string } }
  | { action: "update"; triggerId: string; changes: AppTriggerChange; forBot?: { botId: string; name: string } }
  | { action: "pause" | "resume" | "run_now" | "delete"; triggerId: string; forBot?: { botId: string; name: string } };

/** Durable payload of an app-event automation a bot made or changed from chat: a receipt with what Undo needs. */
export interface AppTriggerRequestCardData {
  version: 1;
  requestId: string;
  botId: string;
  threadId: string;
  createdAt: number;
  operation: AppTriggerRequestOperation;
  resultId?: string;
  undo?: {
    name: string;
    /** The automation's revision right after the change; Undo refuses once it moved. */
    appliedUpdatedAt?: number;
    before?: { name: string; prompt: string; runOn: RoutineRunOn; enabled: boolean; filter?: AppTriggerFilter; config: Record<string, unknown> };
  };
}

export const APP_FILTER_MAX = 200;
export const GMAIL_APP = "gmail";
export const GMAIL_NEW_MESSAGE = "GMAIL_NEW_GMAIL_MESSAGE";

const quoted = (value: string) => {
  const clean = value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  return /\s/.test(clean) ? `"${clean}"` : clean;
};

/** Gmail search syntax for a plain filter: from:, subject:, label: and free words, so filtering happens at the source. */
export function gmailSearchQuery(filter: AppTriggerFilter | undefined): string {
  if (!filter) return "";
  return [
    filter.from && `from:${quoted(filter.from)}`,
    filter.subject && `subject:(${filter.subject.replace(/[()\\]/g, " ").replace(/\s+/g, " ").trim()})`,
    filter.label && `label:${quoted(filter.label).replace(/\s+/g, "-")}`,
    filter.text && quoted(filter.text),
  ].filter(Boolean).join(" ");
}

/** Whether Composio filters this app's events itself from the plain filter (its config), or OpenMausBot does on arrival. */
export function filtersAtSource(app: string): boolean {
  return app === GMAIL_APP;
}

/** A bot may watch an app its connected-app settings let it use: the same grants and scopes its tool calls meet. */
export function botMayWatchApp(
  bot: { composio?: boolean; connectorTools?: Record<string, ConnectorToolGrant>; connectorScopes?: { apps: Record<string, "read" | "write"> } },
  app: string,
): boolean {
  if (bot.composio === false) return false;
  if (bot.connectorTools !== undefined && !Object.hasOwn(bot.connectorTools, app)) return false;
  if (bot.connectorScopes !== undefined && !Object.hasOwn(bot.connectorScopes.apps, app)) return false;
  return true;
}
