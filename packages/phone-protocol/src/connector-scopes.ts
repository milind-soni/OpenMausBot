// Per-bot connection scopes: which connected apps a bot may use, and whether
// only to read. Absent means every connected app, read and write; present, an
// app not listed is off and "read" refuses anything that is not a read. The
// harness enforces it at the connector relay; the app shows the control.
import { KNOWN_READ_SLUGS } from "./outbound.ts";

const READ_VERBS = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "DOWNLOAD", "VIEW", "CHECK", "COUNT"]);

interface ScopedCall {
  slug: string;
  /** The connected account the call names (its id or alias), when it names one. */
  account?: string;
}

export type ConnectorScope = "read" | "write";

export interface ConnectorScopes {
  /** toolkit slug (lower case, Composio's) → what this bot may do with it */
  apps: Record<string, ConnectorScope>;
  /** toolkit slug → the connected-account ids this bot may use in that app. An app with no entry: every account. */
  accounts?: Record<string, string[]>;
}

const TOOLKIT_SLUG = /^(?!__proto__$)[a-z0-9_][a-z0-9_-]{0,63}$/;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** The toolkit a Composio slug belongs to: the part before the first
 * underscore, lower-cased. A leading underscore is part of the toolkit
 * (`_1PASSWORD_GET_ITEM` → `_1password`). A workbench API proxy belongs to no app. */
export function toolkitOf(slug: string): string {
  const start = slug.startsWith("_") ? 1 : 0;
  const cut = slug.indexOf("_", start);
  return (cut > start ? slug.slice(0, cut) : slug).toLowerCase();
}

/** Toolkits whose actions name a one-word resource before the verb
 * (HIGHLEVEL_MCP_CONTACTS_GET_CONTACTS lists contacts). Anything else there,
 * such as a longer resource name, stays a write. */
const RESOURCE_FIRST_TOOLKITS = ["highlevel_mcp"];

/** A read verb first means the tool reads. Creating a draft writes to the
 * account even though it sends nothing, so it is a write here. */
export function isReadOnlyAction(slug: string, toolkit?: string): boolean {
  if (slug === "COMPOSIO_PROXY_EXECUTE") return false;
  if (KNOWN_READ_SLUGS.has(slug)) return true;
  const resourceFirst = RESOURCE_FIRST_TOOLKITS.find((candidate) => (toolkit ?? candidate) === candidate && slug.startsWith(candidate.toUpperCase() + "_"));
  const cut = resourceFirst ? resourceFirst.length : toolkit ? toolkit.length : toolkitOf(slug).length;
  const action = cut > 0 ? slug.slice(cut + 1) : "";
  const verb = action.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)[resourceFirst ? 1 : 0];
  return verb !== undefined && READ_VERBS.has(verb);
}

/** The stored shape, or null when the value is not one. */
export function normalizeConnectorScopes(value: unknown): ConnectorScopes | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as { apps?: unknown }).apps;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const apps: Record<string, ConnectorScope> = Object.create(null);
  for (const [key, scope] of Object.entries(raw as Record<string, unknown>)) {
    const slug = key.trim().toLowerCase();
    if (!TOOLKIT_SLUG.test(slug)) return null;
    if (scope !== "read" && scope !== "write") return null;
    apps[slug] = scope;
  }
  const rawAccounts = (value as { accounts?: unknown }).accounts;
  if (rawAccounts === undefined) return { apps };
  if (!rawAccounts || typeof rawAccounts !== "object" || Array.isArray(rawAccounts)) return null;
  const accounts: Record<string, string[]> = Object.create(null);
  for (const [key, ids] of Object.entries(rawAccounts as Record<string, unknown>)) {
    const slug = key.trim().toLowerCase();
    if (!TOOLKIT_SLUG.test(slug) || !Array.isArray(ids) || !ids.length) return null;
    if (!ids.every((id): id is string => typeof id === "string" && ACCOUNT_ID.test(id))) return null;
    // A limit for an app the bot may not use at all says nothing; dropping it keeps it from waking if the app is turned on.
    if (Object.hasOwn(apps, slug)) accounts[slug] = [...new Set(ids)];
  }
  return Object.keys(accounts).length ? { apps, accounts } : { apps };
}

/** The toolkit a call belongs to: the longest known toolkit its slug starts with, else the part before the first underscore. */
function toolkitFor(slug: string, toolkits: readonly string[]): string {
  return toolkits.filter((candidate) => slug.startsWith(candidate.toUpperCase() + "_"))
    .sort((a, b) => b.length - a.length)[0] ?? toolkitOf(slug);
}

/** The connected-account ids a bot may use in `toolkit`, or undefined when that app has no account limit. */
export function accountLimit(scopes: ConnectorScopes | undefined, toolkit: string): string[] | undefined {
  return scopes?.accounts && Object.hasOwn(scopes.accounts, toolkit) ? scopes.accounts[toolkit] : undefined;
}

export type ConnectorAccess =
  | { ok: true }
  | { ok: false; slug: string; toolkit: string; reason: "app" | "write" | "account"; allowed?: string[] };

/** May this bot run these calls? The first refusal wins, so a batch that
 * mixes an allowed read with a forbidden write is refused whole rather
 * than half-run. In an app with an account limit each call must name an
 * allowed connected-account id in its account field: a call naming none,
 * an alias or another account is refused, so the backend never picks. */
export function connectorAccessDecision(scopes: ConnectorScopes | undefined, calls: ScopedCall[], toolkits: readonly string[] = []): ConnectorAccess {
  if (!scopes) return { ok: true };
  for (const call of calls) {
    const toolkit = toolkitFor(call.slug, toolkits);
    const scope = call.slug === "COMPOSIO_PROXY_EXECUTE" || !Object.hasOwn(scopes.apps, toolkit) ? undefined : scopes.apps[toolkit];
    if (!scope) return { ok: false, slug: call.slug, toolkit, reason: "app" };
    if (scope === "read" && !isReadOnlyAction(call.slug, toolkit)) return { ok: false, slug: call.slug, toolkit, reason: "write" };
    const allowed = accountLimit(scopes, toolkit);
    if (allowed && (!call.account || !allowed.includes(call.account))) return { ok: false, slug: call.slug, toolkit, reason: "account", allowed };
  }
  return { ok: true };
}

/** True when `next` lets the bot do something `previous` did not: limits removed, an app turned on or raised to write, an
 * app's account limit dropped while the app stays on, or an account added to it. No `previous` already allows everything. */
export function widensConnectorScopes(previous: ConnectorScopes | undefined, next: ConnectorScopes | undefined): boolean {
  if (!previous) return false;
  if (!next) return true;
  if (Object.entries(next.apps).some(([slug, scope]) =>
    !Object.hasOwn(previous.apps, slug) || (scope === "write" && previous.apps[slug] === "read"))) return true;
  return Object.entries(previous.accounts ?? {}).some(([slug, ids]) => {
    const after = next.accounts && Object.hasOwn(next.accounts, slug) ? next.accounts[slug] : undefined;
    return after ? after.some((id) => !ids.includes(id)) : Object.hasOwn(next.apps, slug);
  });
}

/** A bot whose scopes switch an app on gets that app's tools: every one, unless its tool list already names some. A tool
 * list that leaves out an app its scopes turn on would give that app no tool on any engine. True when `bot` changed. */
export function grantScopedApps(bot: { connectorScopes?: ConnectorScopes; connectorTools?: Record<string, { tools: "*" | string[] }> }): boolean {
  const tools = bot.connectorTools, scopes = bot.connectorScopes;
  if (!scopes || !tools || typeof tools !== "object" || Array.isArray(tools)) return false;
  const missing = Object.keys(scopes.apps).filter((slug) => !Object.hasOwn(tools, slug));
  if (!missing.length) return false;
  bot.connectorTools = { ...tools, ...Object.fromEntries(missing.map((slug) => [slug, { tools: "*" as const }])) };
  return true;
}

/** One sentence for the bot's prompt, so it does not spend a turn finding
 * out. Empty when the bot is unscoped. */
export function describeConnectorScopes(scopes: ConnectorScopes | undefined): string {
  if (!scopes) return "";
  const entries = Object.entries(scopes.apps);
  if (entries.length === 0) return " This bot has been given no connected apps; do not try to use any.";
  const listed = entries
    .map(([slug, scope]) => `${slug} (${scope === "read" ? "read only" : "read and write"})`)
    .join(", ");
  const accounts = Object.entries(scopes.accounts ?? {})
    .map(([slug, ids]) => ` In ${slug}, use only account id ${ids.map((id) => `"${id}"`).join(" or ")}, and name it in each call's account field.`)
    .join("");
  return ` This bot may use only these connected apps: ${listed}. Do not try others, and do not write to a read-only one.${accounts}`;
}
