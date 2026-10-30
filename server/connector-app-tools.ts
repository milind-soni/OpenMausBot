// The connected-app actions bots reach for most, under plain names that are the same on every engine: gmail.search_emails,
// gmail.read_email_thread, googlecalendar.list_events. Each runs one Composio tool through COMPOSIO_MULTI_EXECUTE_TOOL,
// so the relay judges it exactly as that tool: its grant, the bot's read or write scope, approval cards.
import { isReadOnlyAction, type ConnectorScopes } from "../shared/connector-scopes.ts";
import type { ConnectorToolGrant } from "../shared/wire.ts";
import { toolData } from "./connected-reads.ts";

/** JSON list of the app tools a bridge offers, by their dotted names. */
export const APP_TOOLS_ENV = "OMB_CONNECTOR_APP_TOOLS";
/** "dotted": offer `gmail.search_emails` itself. Claude Code's tool search finds an MCP tool by its own name, and Claude
 * Code turns the dot into `_` in the name it sends; other engines get `gmail_search_emails`, since some providers refuse a
 * dot in a tool name, and they show the same name either way. */
export const APP_TOOL_NAMES_ENV = "OMB_CONNECTOR_APP_TOOL_NAMES";
const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";

type Input = Record<string, unknown>;
interface AppTool {
  name: string;
  slug: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  args(input: Input): Record<string, unknown>;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : undefined);
const count = (value: unknown, fallback: number, max: number): number => {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
};
const addresses = (value: unknown): string[] | undefined => {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;]/) : [];
  const out = list.map((item) => String(item).trim()).filter(Boolean);
  return out.length ? out : undefined;
};
const when = (value: unknown): string | undefined => {
  const raw = text(value);
  if (!raw) return undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? new Date(at).toISOString() : raw;
};

export const APP_TOOLS: readonly AppTool[] = [
  {
    name: "gmail.search_emails",
    slug: "GMAIL_FETCH_EMAILS",
    description: "Search the person's Gmail. query takes Gmail search words (from:ada@example.com, subject:invoice, is:unread, newer_than:7d, after:2026/10/01, in:inbox); leave it out for the newest mail. Returns each message's id, thread id, sender, subject, date and a preview. Read one with gmail.read_email, or its whole conversation with gmail.read_email_thread.",
    properties: {
      query: { type: "string", description: "Gmail search, e.g. \"from:ada@example.com newer_than:7d\"." },
      max_results: { type: "integer", minimum: 1, maximum: 50, description: "How many messages, 1 to 50. Default 10." },
      page_token: { type: "string", description: "The nextPageToken of an earlier search, for the next page." },
    },
    args: (input) => ({
      user_id: "me", query: text(input.query ?? input.q) ?? "", max_results: count(input.max_results ?? input.limit, 10, 50),
      include_payload: false, verbose: false, ...(text(input.page_token) ? { page_token: text(input.page_token) } : {}),
    }),
  },
  {
    name: "gmail.read_email",
    slug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    description: "Read one Gmail message in full: headers, text and attachment names. message_id comes from gmail.search_emails.",
    properties: { message_id: { type: "string", description: "The message id." } },
    required: ["message_id"],
    args: (input) => ({ user_id: "me", message_id: text(input.message_id ?? input.id) ?? "", format: "full" }),
  },
  {
    name: "gmail.read_email_thread",
    slug: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
    description: "Read a whole Gmail conversation, every message in it. thread_id comes from gmail.search_emails.",
    properties: { thread_id: { type: "string", description: "The thread id." } },
    required: ["thread_id"],
    args: (input) => ({ user_id: "me", thread_id: text(input.thread_id ?? input.id) ?? "" }),
  },
  {
    name: "gmail.create_draft",
    slug: "GMAIL_CREATE_EMAIL_DRAFT",
    description: "Save an email as a draft in the person's Gmail without sending it. Give thread_id to draft a reply in that conversation.",
    properties: {
      to: { type: "string", description: "The recipient's address; several separated by commas." },
      subject: { type: "string" },
      body: { type: "string", description: "The text of the email." },
      thread_id: { type: "string", description: "For a reply: the conversation's thread id." },
    },
    required: ["to", "body"],
    args: (input) => {
      const [first, ...rest] = addresses(input.to ?? input.recipient_email) ?? [];
      return {
        user_id: "me", recipient_email: first ?? "", body: String(input.body ?? ""), subject: String(input.subject ?? ""),
        ...(rest.length ? { extra_recipients: rest } : {}), ...(text(input.thread_id) ? { thread_id: text(input.thread_id) } : {}),
      };
    },
  },
  {
    name: "gmail.send_email",
    slug: "GMAIL_SEND_EMAIL",
    description: "Send an email from the person's Gmail.",
    properties: {
      to: { type: "string", description: "The recipient's address; several separated by commas." },
      subject: { type: "string" },
      body: { type: "string", description: "The text of the email." },
      cc: { type: "string", description: "Addresses to copy, separated by commas." },
    },
    required: ["to", "subject", "body"],
    args: (input) => {
      const [first, ...rest] = addresses(input.to ?? input.recipient_email) ?? [];
      const cc = addresses(input.cc);
      return {
        user_id: "me", recipient_email: first ?? "", subject: String(input.subject ?? ""), body: String(input.body ?? ""),
        ...(rest.length ? { extra_recipients: rest } : {}), ...(cc ? { cc } : {}),
      };
    },
  },
  {
    name: "googlecalendar.list_events",
    slug: "GOOGLECALENDAR_EVENTS_LIST",
    description: "List the events on the person's Google Calendar between two times, earliest first. Times are ISO 8601, e.g. 2026-10-28T09:00:00+01:00.",
    properties: {
      time_min: { type: "string", description: "Start of the window. Default now." },
      time_max: { type: "string", description: "End of the window." },
      calendar_id: { type: "string", description: "A calendar id from googlecalendar.list_calendars. Default the primary calendar." },
      max_results: { type: "integer", minimum: 1, maximum: 250, description: "Default 50." },
    },
    args: (input) => ({
      calendarId: text(input.calendar_id ?? input.calendarId) ?? "primary", timeMin: when(input.time_min ?? input.timeMin) ?? new Date().toISOString(),
      ...(when(input.time_max ?? input.timeMax) ? { timeMax: when(input.time_max ?? input.timeMax) } : {}),
      singleEvents: true, orderBy: "startTime", maxResults: count(input.max_results, 50, 250),
    }),
  },
  {
    name: "googlecalendar.list_calendars",
    slug: "GOOGLECALENDAR_LIST_CALENDARS",
    description: "List the person's Google calendars, with each one's id.",
    properties: {},
    args: () => ({}),
  },
];

/** The app tool names in a bridge's environment; anything else reads as none. */
export function parseAppToolsEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string" && APP_TOOLS.some((tool) => tool.name === name)) : [];
  } catch {
    return [];
  }
}

const BY_NAME = new Map(APP_TOOLS.flatMap((tool) => [[tool.name, tool], [plainName(tool.name), tool]] as const));

function plainName(name: string): string {
  return name.replace(".", "_");
}

const appOf = (tool: AppTool) => tool.name.slice(0, tool.name.indexOf("."));

/** The app tools a bot gets: those of its connected apps whose tool its grants allow, and only reads where it may only read. */
export function appToolsFor(bot: { connectorTools?: Record<string, ConnectorToolGrant>; connectorScopes?: ConnectorScopes }, connected: readonly string[]): string[] {
  return APP_TOOLS.filter((tool) => {
    const app = appOf(tool);
    if (!connected.includes(app)) return false;
    const grant = bot.connectorTools === undefined ? { tools: "*" as const } : Object.hasOwn(bot.connectorTools, app) ? bot.connectorTools[app] : undefined;
    if (!grant || (grant.tools !== "*" && !grant.tools.includes(tool.slug))) return false;
    if (!bot.connectorScopes) return true;
    const scope = Object.hasOwn(bot.connectorScopes.apps, app) ? bot.connectorScopes.apps[app] : undefined;
    return scope === "write" || (scope === "read" && isReadOnlyAction(tool.slug, app));
  }).map((tool) => tool.name);
}

/** The tools/list entries for `names`, as the bridge offers them. */
export function appToolEntries(names: readonly string[], style: "dotted" | "plain"): Array<Record<string, unknown>> {
  return APP_TOOLS.filter((tool) => names.includes(tool.name)).map((tool) => ({
    name: style === "dotted" ? tool.name : plainName(tool.name),
    description: tool.description,
    inputSchema: { type: "object", additionalProperties: false, properties: tool.properties, ...(tool.required ? { required: tool.required } : {}) },
    annotations: { readOnlyHint: isReadOnlyAction(tool.slug, appOf(tool)) },
  }));
}

/** The Composio call an app tool's call stands for, by either spelling of its name, or null for any other tool. */
export function appToolCall(name: string, input: unknown): { slug: string; frame(id: unknown): Record<string, unknown> } | null {
  const tool = BY_NAME.get(name.trim().toLowerCase());
  if (!tool) return null;
  const args = tool.args(input && typeof input === "object" && !Array.isArray(input) ? input as Input : {});
  return {
    slug: tool.slug,
    frame: (id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: MULTI_EXECUTE, arguments: { tools: [{ tool_slug: tool.slug, arguments: args }] } } }),
  };
}

/** The app tool's answer: the one tool's data, or the relay's frame as it came when that cannot be read (a refusal, an error). */
export function appToolAnswer(slug: string, frame: Record<string, unknown>): Record<string, unknown> {
  let data: unknown;
  try {
    data = toolData(slug, frame);
  } catch {
    return frame;
  }
  return { ...frame, result: { content: [{ type: "text", text: JSON.stringify(data) }] } };
}
