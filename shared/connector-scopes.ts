// Per-bot connection scopes: which connected apps a bot may use, and
// whether it may only read them or also write. Absent means what it has
// always meant — every connected app, read and write — so nothing changes
// for a bot nobody has scoped. Present means a list: an app not on it is
// off for this bot, and "read" refuses anything that is not a read.
//
// Shared between the harness (which enforces it at the connector relay,
// seeing through Composio's meta tools) and the app (which shows the
// control), so both agree on what a scope means.
// No import from outbound.ts: shared/ is compiled by both the server (which
// needs .ts extensions) and the app (which forbids them), so shared modules
// stand alone. The read-verb rule is repeated here in its Composio-only form.

const READ_VERBS = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "DOWNLOAD", "VIEW", "CHECK", "COUNT"]);

/** One app tool a request would run; matches ConnectorCall in outbound.ts. */
interface ScopedCall {
  slug: string;
}

export type ConnectorScope = "read" | "write";

export interface ConnectorScopes {
  /** toolkit slug (lower case, Composio's) → what this bot may do with it */
  apps: Record<string, ConnectorScope>;
}

const TOOLKIT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The toolkit a Composio slug belongs to: the part before the first
 * underscore, lower-cased. A workbench API proxy belongs to no app. */
export function toolkitOf(slug: string): string {
  const cut = slug.indexOf("_");
  return (cut > 0 ? slug.slice(0, cut) : slug).toLowerCase();
}

/** A read verb first means the tool reads. Creating a draft writes to the
 * account even though it sends nothing, so it is a write here. */
export function isReadOnlyAction(slug: string): boolean {
  if (slug === "COMPOSIO_PROXY_EXECUTE") return false;
  const cut = slug.indexOf("_");
  const action = cut > 0 ? slug.slice(cut + 1) : "";
  const first = action.toUpperCase().split(/[^A-Z0-9]+/).find(Boolean);
  return first !== undefined && READ_VERBS.has(first);
}

/** The stored shape, or null when the value is not one. */
export function normalizeConnectorScopes(value: unknown): ConnectorScopes | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as { apps?: unknown }).apps;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const apps: Record<string, ConnectorScope> = {};
  for (const [key, scope] of Object.entries(raw as Record<string, unknown>)) {
    const slug = key.trim().toLowerCase();
    if (!TOOLKIT_SLUG.test(slug)) return null;
    if (scope !== "read" && scope !== "write") return null;
    apps[slug] = scope;
  }
  return { apps };
}

export type ConnectorAccess =
  | { ok: true }
  | { ok: false; slug: string; toolkit: string; reason: "app" | "write" };

/** May this bot run these calls? The first refusal wins, so a batch that
 * mixes an allowed read with a forbidden write is refused whole rather
 * than half-run. */
export function connectorAccessDecision(scopes: ConnectorScopes | undefined, calls: ScopedCall[]): ConnectorAccess {
  if (!scopes) return { ok: true };
  for (const call of calls) {
    const toolkit = toolkitOf(call.slug);
    const scope = call.slug === "COMPOSIO_PROXY_EXECUTE" ? undefined : scopes.apps[toolkit];
    if (!scope) return { ok: false, slug: call.slug, toolkit, reason: "app" };
    if (scope === "read" && !isReadOnlyAction(call.slug)) return { ok: false, slug: call.slug, toolkit, reason: "write" };
  }
  return { ok: true };
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
  return ` This bot may use only these connected apps: ${listed}. Do not try others, and do not write to a read-only one.`;
}
