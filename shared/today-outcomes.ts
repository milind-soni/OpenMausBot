// Which business outcome a finished app tool call is, and how many minutes a
// person would spend on one by hand. Connected-app tools are named
// APP_VERB_NOUN (Composio's GMAIL_SEND_EMAIL, an MCP server's
// mcp__notion__notion-create-pages); built-in tools and the app's own
// coordination tools are not outcomes and classify as nothing.
import { connectorCallsIn, isOutboundTool } from "./outbound.ts";
import { isConnectedAppsServer } from "./own-apps.ts";

export const OUTCOME_CATEGORIES = ["emailRead", "draft", "emailSent", "message", "doc", "report", "lead", "other"] as const;
export type OutcomeCategory = (typeof OUTCOME_CATEGORIES)[number];
export type OutcomeCounts = Partial<Record<OutcomeCategory, number>>;

/** Minutes a person would usually spend doing one of each by hand. Time saved
 * is their sum over finished outcomes: an estimate, never a measurement. */
export const MINUTES_PER_OUTCOME: Record<OutcomeCategory, number> = {
  emailRead: 2,
  draft: 5,
  emailSent: 4,
  message: 2,
  doc: 10,
  report: 15,
  lead: 3,
  other: 1,
};

export function minutesSaved(counts: OutcomeCounts): number {
  return OUTCOME_CATEGORIES.reduce((sum, category) => sum + (counts[category] ?? 0) * MINUTES_PER_OUTCOME[category], 0);
}

const EMAIL_APPS = new Set(["GMAIL", "OUTLOOK", "ZOHOMAIL", "AGENTMAIL", "SENDGRID", "RESEND", "POSTMARK", "MAILGUN", "FASTMAIL", "YAHOOMAIL"]);
/** CRMs: creating, updating, searching or enriching a person, company or deal is a lead or record. */
const CRM_APPS = new Set(["HUBSPOT", "SALESFORCE", "PIPEDRIVE", "ZOHO", "ATTIO", "CLOSE", "COPPER", "FRESHSALES", "HIGHLEVEL", "AFFINITY", "FOLK", "KEAP", "ACTIVECAMPAIGN"]);
/** Prospecting and enrichment services: every call looks people or companies up. */
const PROSPECTING_APPS = new Set(["APOLLO", "HUNTER", "CLEARBIT", "LUSHA", "SNOV", "PEOPLEDATALABS", "ROCKETREACH", "PROSPEO", "DROPCONTACT"]);
const DOC_APPS = new Set([
  "NOTION", "GOOGLEDOCS", "GOOGLESHEETS", "GOOGLESLIDES", "GOOGLEDRIVE", "CONFLUENCE", "CODA", "DROPBOX", "ONEDRIVE",
  "SHAREPOINT", "EXCEL", "BOX", "AIRTABLE", "CANVA", "WORDPRESS", "WEBFLOW", "GHOST", "EVERNOTE", "OBSIDIAN",
]);
/** App names that are two words in a tool name. */
const TWO_WORD_APPS = new Set(["MICROSOFT_TEAMS", "GOOGLE_DRIVE", "GOOGLE_DOCS", "GOOGLE_SHEETS", "GOOGLE_CALENDAR", "ZOHO_MAIL", "ZOHO_CRM"]);

const READ = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "VIEW", "CHECK", "QUERY", "COUNT", "DOWNLOAD", "DESCRIBE"]);
const SEND = new Set(["SEND", "SENDS", "REPLY", "RESPOND", "FORWARD"]);
const WRITE = new Set(["CREATE", "CREATION", "ADD", "UPDATE", "APPEND", "INSERT", "UPLOAD", "WRITE", "EDIT", "REPLACE", "UPSERT", "DUPLICATE", "COPY", "NEW", "SET", "PATCH", "SAVE", "PUBLISH"]);
const TRIAGE = new Set(["LABEL", "LABELS", "ARCHIVE", "MOVE", "MARK", "TRASH", "STAR", "MODIFY", "DELETE", "UNTRASH", "SNOOZE"]);
const MONEY = new Set(["REFUND", "CHARGE", "PAY", "PAYOUT", "TRANSFER"]);
const OTHER_ACTION = new Set([...SEND, ...WRITE, ...TRIAGE, ...MONEY, "REMOVE", "CANCEL", "POST", "SHARE", "INVITE", "RUN", "EXECUTE", "TRIGGER", "START", "STOP", "SCHEDULE", "ASSIGN", "CLOSE", "MERGE"]);
const EMAIL_NOUNS = new Set(["EMAIL", "EMAILS", "MAIL", "MAILS", "MESSAGE", "MESSAGES", "THREAD", "THREADS", "INBOX", "CONVERSATION", "CONVERSATIONS"]);
const LEAD_NOUNS = new Set([
  "LEAD", "LEADS", "CONTACT", "CONTACTS", "PROSPECT", "PROSPECTS", "PERSON", "PEOPLE", "COMPANY", "COMPANIES",
  "ORGANIZATION", "ORGANIZATIONS", "DEAL", "DEALS", "OPPORTUNITY", "OPPORTUNITIES", "CUSTOMER", "CUSTOMERS",
]);
const LEAD_VERBS = new Set(["CREATE", "ADD", "UPDATE", "UPSERT", "ENRICH", "SEARCH", "FIND", "LOOKUP", "MATCH", "DISCOVER"]);

/** The app's own MCP servers: coordination, computers and the permission bridge, never a business outcome. */
const OWN_SERVERS = new Set(["agents", "computer", "localComputer", "phone", "browser", "dweb", "ogb"]);
const COMPOSIO_META = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_WAIT_FOR_CONNECTIONS", "COMPOSIO_CHECK_ACTIVE_CONNECTION", "COMPOSIO_INITIATE_CONNECTION"]);
const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
const APP_TOOL = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;

const words = (text: string): string[] => text.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
const any = (tokens: readonly string[], set: ReadonlySet<string>) => tokens.some((token) => set.has(token));

interface AppTool { app: string; action: string[] }

/** The app and action words of a connected-app tool, or null for a built-in or one of the app's own tools. */
export function appTool(name: string): AppTool | null {
  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    const action = rest.join("__");
    if (isConnectedAppsServer(server) || server === "highlevel") return appTool(action);
    if (OWN_SERVERS.has(server) || !action) return null;
    const app = words(server.replace(/^claude_ai_/, "")).join("");
    const tokens = words(action);
    return { app, action: tokens[0] === app ? tokens.slice(1) : tokens };
  }
  if (!APP_TOOL.test(name)) return null;
  const tokens = name.split("_").filter(Boolean);
  const two = tokens.length > 2 ? `${tokens[0]}_${tokens[1]}` : "";
  return TWO_WORD_APPS.has(two)
    ? { app: two.replace("_", ""), action: tokens.slice(2) }
    : { app: tokens[0]!, action: tokens.slice(1) };
}

/** Composio's toolkit name for display: GOOGLESHEETS stays one word, the rest read as written. */
export function appName(name: string): string | null {
  return appTool(name)?.app ?? null;
}

function classifyAction({ app, action }: AppTool, name: string): OutcomeCategory | null {
  if (app === "COMPOSIO") return COMPOSIO_META.has(name) ? null : "other";
  const first = action[0] ?? "";
  if (action.includes("DRAFT") || action.includes("DRAFTS")) {
    if (action.includes("SEND")) return "emailSent";
    if (any(action, WRITE)) return "draft";
  }
  if (EMAIL_APPS.has(app)) {
    if (any(action, SEND)) return "emailSent";
    if (READ.has(first)) return any(action, EMAIL_NOUNS) ? "emailRead" : null;
    if (first === "CREATE") return "other";
    if (any(action, TRIAGE)) return "emailRead";
  }
  if (PROSPECTING_APPS.has(app)) return "lead";
  if (any(action, LEAD_VERBS) && (any(action, new Set(["LEAD", "LEADS", "PROSPECT", "PROSPECTS"])) || (CRM_APPS.has(app) && any(action, LEAD_NOUNS)))) return "lead";
  if ((action.includes("EMAIL") || action.includes("MAIL")) && any(action, SEND)) return "emailSent";
  if (DOC_APPS.has(app) && !READ.has(first) && any(action, WRITE)) return "doc";
  if (isOutboundTool(name)) return any(action, MONEY) ? "other" : "message";
  if (any(action, OTHER_ACTION)) return "other";
  if (any(action, READ)) return null;
  return "other";
}

const SLUG_IN_PREVIEW = /"(?:tool_slug|slug)"\s*:\s*"([A-Z][A-Z0-9_]+)"/g;

/** The app tools one multi-execute call ran, read from its recorded input preview. */
function executedSlugs(input: string | undefined): string[] {
  if (!input) return [];
  try {
    const slugs = connectorCallsIn(MULTI_EXECUTE, JSON.parse(input)).map((call) => call.slug);
    if (!slugs.includes("COMPOSIO_PROXY_EXECUTE")) return slugs;
  } catch {}
  return [...input.matchAll(SLUG_IN_PREVIEW)].map((match) => match[1]!);
}

/**
 * The outcomes one finished tool call produced: one per app tool it ran. A
 * multi-execute call is read through its recorded input; when that names no
 * tool it counts once, as "other".
 */
export function classifyToolCall(name: string, input?: string): OutcomeCategory[] {
  const tool = appTool(name);
  if (!tool) return [];
  const bare = tool.app === "COMPOSIO" ? `COMPOSIO_${tool.action.join("_")}` : name;
  if (bare === MULTI_EXECUTE) {
    const slugs = executedSlugs(input);
    if (!slugs.length) return ["other"];
    return slugs.flatMap((slug) => classifyToolCall(slug));
  }
  const category = classifyAction(tool, bare.startsWith("mcp__") ? [tool.app, ...tool.action].join("_") : bare);
  return category ? [category] : [];
}

/** The apps a tool call touched, for naming a broken connection. */
export function toolApps(name: string, input?: string): string[] {
  const tool = appTool(name);
  if (!tool) return [];
  if (tool.app !== "COMPOSIO") return [tool.app];
  if (`COMPOSIO_${tool.action.join("_")}` !== MULTI_EXECUTE) return [];
  return [...new Set(executedSlugs(input).flatMap((slug) => appTool(slug)?.app ?? []))];
}

const REPORT_NAME = /\b(?:brief|briefing|report|summary|digest|recap|round-?up|overview|stand-?up|kpis?|metrics|newsletter|analytics|insights)s?\b/i;

/** A routine whose name says it delivers a report or briefing. */
export function isReportRoutine(name: string): boolean {
  return REPORT_NAME.test(name);
}
