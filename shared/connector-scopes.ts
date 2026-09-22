/**
 * Per-bot authorization for the connected-app bridge.
 *
 * This module is intentionally pure and shared by the server, the bridge,
 * and the renderer. The model may discover a Composio tool by name, but the
 * name is never authority: the relay evaluates the toolkit, selected account,
 * and verb class before forwarding a request upstream.
 */

export const CONNECTOR_SCOPES = ["read", "draft", "send", "modify", "delete"] as const;
export type ConnectorScope = (typeof CONNECTOR_SCOPES)[number];

export interface ConnectorGrant {
  /** Composio connected-account id. Omitted means any account for the toolkit. */
  accountId?: string;
  /** Explicitly granted verb classes. An empty list grants no calls. */
  scopes: readonly ConnectorScope[];
}

export type ConnectorGrants = Record<string, ConnectorGrant>;

export type ConnectorDeniedDecision = {
  ok: false;
  reason: "toolkit" | "scope" | "account";
  toolkit: string;
  toolName: string;
  required?: ConnectorScope;
};

export type ConnectorCallDecision =
  | { ok: true }
  | ConnectorDeniedDecision;

const TOOLKIT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const scopeSet = new Set<string>(CONNECTOR_SCOPES);

const DELETE_TOKENS = new Set(["DELETE", "DELETES", "REMOVE", "REMOVES", "DESTROY", "DESTROYS", "ARCHIVE", "ARCHIVES", "TRASH", "TRASHES", "REVOKE", "REVOKES", "DISCONNECT", "DISCONNECTS"]);
const SEND_TOKENS = new Set(["SEND", "SENDS", "SENDING", "POST", "POSTS", "PUBLISH", "PUBLISHES", "REPLY", "REPLIES", "FORWARD", "FORWARDS"]);
const DRAFT_TOKENS = new Set(["DRAFT", "DRAFTS"]);
const MODIFY_TOKENS = new Set(["UPDATE", "UPDATES", "CREATE", "CREATES", "ADD", "ADDS", "MOVE", "MOVES", "SET", "SETS", "PATCH", "PATCHES", "EDIT", "EDITS", "UPLOAD", "UPLOADS", "INSERT", "INSERTS"]);
const READ_TOKENS = new Set(["GET", "GETS", "LIST", "LISTS", "FETCH", "FETCHES", "SEARCH", "SEARCHES", "READ", "READS", "FIND", "FINDS", "RETRIEVE", "RETRIEVES", "LOOKUP", "LOOKUPS", "DOWNLOAD", "DOWNLOADS", "VIEW", "VIEWS", "CHECK", "CHECKS", "COUNT", "COUNTS"]);

function toolTokens(toolName: string): string[] {
  return toolName
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** The toolkit slug at the start of a generated Composio tool name.
 * When the caller knows the installed toolkit slugs, prefer the longest
 * matching prefix so names such as `google_sheets_*` do not collapse to the
 * unrelated `google` prefix. */
export function toolkitOf(toolName: string, knownToolkits?: Iterable<string>): string {
  const normalized = toolName.trim().toLowerCase();
  let longest: string | undefined;
  for (const candidate of knownToolkits ?? []) {
    const toolkit = candidate.trim().toLowerCase();
    if ((normalized === toolkit || normalized.startsWith(`${toolkit}_`)) && (!longest || toolkit.length > longest.length)) {
      longest = toolkit;
    }
  }
  if (longest) return longest;
  const cut = normalized.indexOf("_");
  return (cut > 0 ? normalized.slice(0, cut) : normalized);
}

/**
 * Classify generated Composio names from most destructive to least
 * destructive. Unknown names deliberately become `delete`: a new provider
 * action must be granted explicitly before it can run.
 */
export function classifyTool(toolName: string): ConnectorScope {
  const tokens = toolTokens(toolName);
  if (tokens.some((token) => DELETE_TOKENS.has(token))) return "delete";
  if (tokens.some((token) => SEND_TOKENS.has(token))) return "send";
  // Draft must precede CREATE, which is a modify token.
  if (tokens.some((token) => DRAFT_TOKENS.has(token))) return "draft";
  if (tokens.some((token) => MODIFY_TOKENS.has(token))) return "modify";
  if (tokens.some((token) => READ_TOKENS.has(token))) return "read";
  return "delete";
}

/** Validate the persisted/API grant shape and canonicalize toolkit keys. */
export function normalizeConnectorGrants(value: unknown): ConnectorGrants | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const grants: ConnectorGrants = {};
  for (const [rawToolkit, rawGrant] of Object.entries(value as Record<string, unknown>)) {
    const toolkit = rawToolkit.trim().toLowerCase();
    if (!TOOLKIT_SLUG.test(toolkit) || !rawGrant || typeof rawGrant !== "object" || Array.isArray(rawGrant)) return null;
    if (Object.hasOwn(grants, toolkit)) return null;
    const grant = rawGrant as { accountId?: unknown; scopes?: unknown };
    if (!Array.isArray(grant.scopes) || grant.scopes.some((scope) => typeof scope !== "string" || !scopeSet.has(scope))) return null;
    const scopes = [...(grant.scopes as ConnectorScope[])];
    if (new Set(scopes).size !== scopes.length) return null;
    const accountId = grant.accountId === undefined ? undefined : grant.accountId;
    if (accountId !== undefined && (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId))) return null;
    grants[toolkit] = {
      scopes,
      ...(accountId === undefined ? {} : { accountId }),
    };
  }
  return grants;
}

/** Evaluate one concrete connector action at the authorization boundary. */
export function evaluateConnectorCall(
  grants: ConnectorGrants | undefined,
  toolkit: string,
  toolName: string,
  accountId?: string,
): ConnectorCallDecision {
  // Undefined is the migration state for legacy bots: preserve the old
  // boolean behavior until a person chooses explicit grants.
  if (grants === undefined) return { ok: true };
  const normalizedToolkit = toolkit.trim().toLowerCase();
  const grant = Object.hasOwn(grants, normalizedToolkit) ? grants[normalizedToolkit] : undefined;
  if (!grant) return { ok: false, reason: "toolkit", toolkit: normalizedToolkit, toolName };
  if (grant.accountId !== undefined && accountId !== grant.accountId) {
    return { ok: false, reason: "account", toolkit: normalizedToolkit, toolName };
  }
  const required = classifyTool(toolName);
  if (!grant.scopes.includes(required)) {
    return { ok: false, reason: "scope", toolkit: normalizedToolkit, toolName, required };
  }
  return { ok: true };
}

/** A concise, non-probing refusal suitable for returning to the model. */
export function connectorScopeRefusal(decision: ConnectorDeniedDecision): string {
  if (decision.reason === "toolkit") {
    return `OpenMausBot did not run ${decision.toolName}: this connected-app service is not authorized for this bot. Ask the user to grant it under the bot's Access settings, and do not retry.`;
  }
  if (decision.reason === "account") {
    return `OpenMausBot did not run ${decision.toolName}: the selected connected account is not authorized for this bot. Ask the user to review the bot's Access settings, and do not retry.`;
  }
  return `OpenMausBot did not run ${decision.toolName}: this action requires the ${decision.required} connector scope, which this bot has not been granted. Ask the user to review Access settings, and do not retry.`;
}

/** Prompt context for a bot with explicit grants. */
export function describeConnectorGrants(grants: ConnectorGrants | undefined): string {
  if (grants === undefined) return "";
  const entries = Object.entries(grants);
  if (!entries.length) return " This bot has no connected-app grants; do not use connected apps.";
  const text = entries
    .map(([toolkit, grant]) => `${toolkit} (${grant.scopes.length ? grant.scopes.join(", ") : "no access"}${grant.accountId ? `, account ${grant.accountId}` : ""})`)
    .join("; ");
  return ` This bot may use only these connected-app grants: ${text}. Unknown or unlisted actions are not authorized.`;
}
