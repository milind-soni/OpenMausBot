import {
  evaluateConnectorCall,
  connectorScopeRefusal,
  toolkitOf,
  type ConnectorCallDecision,
  type ConnectorDeniedDecision,
  type ConnectorGrants,
} from "../shared/connector-scopes.ts";

type JsonObject = Record<string, unknown>;

const CONNECTION_TOOLS = new Set(["COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_WAIT_FOR_CONNECTIONS"]);
const SEARCH_TOOL = "COMPOSIO_SEARCH_TOOLS";
const SCHEMA_TOOL = "COMPOSIO_GET_TOOL_SCHEMAS";
const EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

export type ConnectorScopeGateResult =
  | { ok: true; body: JsonObject }
  | { ok: false; decision: ConnectorDeniedDecision; message: string };

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function grantFor(grants: ConnectorGrants, toolkit: string) {
  return Object.hasOwn(grants, toolkit) ? grants[toolkit] : undefined;
}

function toolkitFor(grants: ConnectorGrants | undefined, toolName: string): string {
  return toolkitOf(toolName, grants ? Object.keys(grants) : undefined);
}

function paramsOf(body: JsonObject): JsonObject {
  return object(body.params) ?? {};
}

function argsOf(params: JsonObject): JsonObject | null {
  return object(params.arguments);
}

function bareToolName(value: string): string {
  const pieces = value.split("__");
  return (pieces.at(-1) ?? value).trim().toUpperCase();
}

function accountIdOf(value: JsonObject): string | undefined {
  for (const key of ["connected_account_id", "connectedAccountId", "account_id", "accountId", "account"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return undefined;
}

function pinAccount(value: JsonObject, accountId: string): JsonObject {
  const next: JsonObject = { ...value, connected_account_id: accountId };
  if (Object.hasOwn(value, "account_id")) next.account_id = accountId;
  if (Object.hasOwn(value, "accountId")) next.accountId = accountId;
  if (Object.hasOwn(value, "connectedAccountId")) next.connectedAccountId = accountId;
  if (Object.hasOwn(value, "account")) next.account = accountId;
  return next;
}

function accountIdOfRow(row: JsonObject): string | undefined {
  const nested = object(row.arguments);
  return accountIdOf(row) ?? (nested ? accountIdOf(nested) : undefined);
}

function pinAccountInRow(row: JsonObject, accountId: string): JsonObject {
  const next: JsonObject = { ...pinAccount(row, accountId), account: accountId };
  const nested = object(row.arguments);
  if (nested) next.arguments = pinAccount(nested, accountId);
  return next;
}

function denial(decision: ConnectorCallDecision): ConnectorScopeGateResult {
  if (decision.ok) throw new Error("cannot deny an allowed connector decision");
  return { ok: false, decision, message: connectorScopeRefusal(decision) };
}

function decisionForTool(
  grants: ConnectorGrants | undefined,
  toolName: string,
  args: JsonObject | null,
): { result: ConnectorScopeGateResult; args: JsonObject | null } {
  const normalized = bareToolName(toolName);
  const toolkit = toolkitFor(grants, normalized);
  const suppliedAccount = args ? accountIdOf(args) : undefined;
  const grant = grants ? grantFor(grants, toolkit) : undefined;
  const effectiveAccount = suppliedAccount ?? grant?.accountId;
  const checked = evaluateConnectorCall(grants, toolkit, normalized, effectiveAccount);
  if (!checked.ok) return { result: denial(checked), args };
  if (grant?.accountId && args) return { result: { ok: true, body: {} }, args: pinAccount(args, grant.accountId) };
  if (grant?.accountId && !args) {
    return {
      result: denial({ ok: false, reason: "account", toolkit, toolName: normalized }),
      args,
    };
  }
  return { result: { ok: true, body: {} }, args };
}

function toolkitFilters(args: JsonObject): string[] {
  const values: unknown[] = [];
  if (typeof args.toolkit === "string") values.push(args.toolkit);
  if (Array.isArray(args.toolkits)) values.push(...args.toolkits);
  return values.flatMap((value) => {
    if (typeof value === "string") return [value.trim().toLowerCase()];
    const row = object(value);
    if (row && typeof row.toolkit === "string") return [row.toolkit.trim().toLowerCase()];
    if (row && typeof row.slug === "string") return [row.slug.trim().toLowerCase()];
    return [];
  });
}

function connectionToolkits(args: JsonObject): Array<{ toolkit: string; action?: string; accountId?: string }> {
  if (!Array.isArray(args.toolkits)) return [];
  return args.toolkits.flatMap((value) => {
    if (typeof value === "string") return [{ toolkit: value.trim().toLowerCase() }];
    const row = object(value);
    if (!row) return [];
    const raw = typeof row.toolkit === "string" ? row.toolkit : typeof row.name === "string" ? row.name : undefined;
    if (!raw) return [];
    const accountId = accountIdOf(row);
    return [{
      toolkit: raw.trim().toLowerCase(),
      ...(typeof row.action === "string" ? { action: row.action.toLowerCase() } : {}),
      ...(accountId ? { accountId } : {}),
    }];
  });
}

function toolNames(args: JsonObject): string[] {
  const raw = Array.isArray(args.tool_names)
    ? args.tool_names
    : Array.isArray(args.tool_slugs)
      ? args.tool_slugs
      : Array.isArray(args.tools) ? args.tools : [];
  return raw.flatMap((value) => {
    if (typeof value === "string") return [value];
    const row = object(value);
    if (!row) return [];
    for (const key of ["tool_slug", "toolName", "tool_name", "name"]) {
      if (typeof row[key] === "string") return [row[key]];
    }
    return [];
  });
}

function executeRows(args: JsonObject): JsonObject[] | null {
  if (!Array.isArray(args.tools) || !args.tools.length) return null;
  const rows = args.tools.map(object);
  return rows.every((row): row is JsonObject => row !== null) ? rows : null;
}

/**
 * Check and, where an account is pinned, bind one JSON-RPC request to that
 * account before it reaches Composio. Undefined grants preserve the legacy
 * `composio !== false` behavior; `{}` is an explicit deny-all map.
 */
export function gateConnectorRpc(body: unknown, grants: ConnectorGrants | undefined): ConnectorScopeGateResult {
  const rpc = object(body);
  if (!rpc) {
    const decision: ConnectorCallDecision = { ok: false, reason: "toolkit", toolkit: "unknown", toolName: "unknown connector request" };
    return denial(decision);
  }
  if (grants === undefined || rpc.method !== "tools/call") return { ok: true, body: rpc };

  const params = paramsOf(rpc);
  const rawName = typeof params.name === "string" ? params.name : "";
  const name = bareToolName(rawName);
  const args = argsOf(params);

  if (CONNECTION_TOOLS.has(name)) {
    if (!args) {
      const decision: ConnectorCallDecision = { ok: false, reason: "toolkit", toolkit: "unknown", toolName: name };
      return denial(decision);
    }
    const requested: Array<{ toolkit: string; action?: string; accountId?: string }> = connectionToolkits(args);
    if (!requested.length) {
      const decision: ConnectorCallDecision = { ok: false, reason: "toolkit", toolkit: "unknown", toolName: name };
      return denial(decision);
    }
    for (const item of requested) {
      const grant = grantFor(grants, item.toolkit);
      if (!grant || grant.scopes.length === 0) {
        const decision: ConnectorCallDecision = { ok: false, reason: "toolkit", toolkit: item.toolkit, toolName: name };
        return denial(decision);
      }
      if (grant.accountId !== undefined && grant.accountId !== item.accountId) {
        const decision: ConnectorCallDecision = { ok: false, reason: "account", toolkit: item.toolkit, toolName: name };
        return denial(decision);
      }
      if (item.action && ["remove", "delete"].includes(item.action) && !grant.scopes.includes("delete")) {
        const decision: ConnectorCallDecision = { ok: false, reason: "scope", toolkit: item.toolkit, toolName: name, required: "delete" };
        return denial(decision);
      }
    }
    return { ok: true, body: rpc };
  }

  if (name === SEARCH_TOOL) {
    if (!args) {
      const decision: ConnectorCallDecision = { ok: false, reason: "toolkit", toolkit: "unknown", toolName: name };
      return denial(decision);
    }
    const requested = toolkitFilters(args);
    const allowed = Object.keys(grants);
    const scoped = requested.length ? requested : allowed;
    const outside = scoped.find((toolkit) => !grantFor(grants, toolkit));
    if (outside || !scoped.length) {
      const decision: ConnectorCallDecision = { ok: false, reason: "toolkit", toolkit: outside ?? "unknown", toolName: name };
      return denial(decision);
    }
    // Current Composio search uses `queries`, not a toolkit filter. The
    // response is filtered at the relay boundary; do not add an unsupported
    // field to this strict schema just to express our policy.
    return { ok: true, body: rpc };
  }

  if (name === SCHEMA_TOOL) {
    if (!args) {
      const decision: ConnectorCallDecision = { ok: false, reason: "toolkit", toolkit: "unknown", toolName: name };
      return denial(decision);
    }
    const names = toolNames(args);
    if (!names.length) {
      const decision: ConnectorCallDecision = { ok: false, reason: "toolkit", toolkit: "unknown", toolName: name };
      return denial(decision);
    }
    for (const candidate of names) {
      const toolkit = toolkitFor(grants, bareToolName(candidate));
      if (!grantFor(grants, toolkit)) {
        const decision: ConnectorCallDecision = { ok: false, reason: "toolkit", toolkit, toolName: bareToolName(candidate) };
        return denial(decision);
      }
    }
    return { ok: true, body: rpc };
  }

  if (name === EXECUTE_TOOL) {
    const rows = args ? executeRows(args) : null;
    if (!rows) {
      const decision: ConnectorCallDecision = { ok: false, reason: "scope", toolkit: "unknown", toolName: name, required: "delete" };
      return denial(decision);
    }
    const nextRows: JsonObject[] = [];
    for (const row of rows) {
      const candidate = ["tool_slug", "toolName", "tool_name", "name"].map((key) => row[key]).find((value): value is string => typeof value === "string");
      if (!candidate) {
        const decision: ConnectorCallDecision = { ok: false, reason: "scope", toolkit: "unknown", toolName: name, required: "delete" };
        return denial(decision);
      }
      const normalizedCandidate = bareToolName(candidate);
      const toolkit = toolkitFor(grants, normalizedCandidate);
      const grant = grantFor(grants, toolkit);
      const selectedAccount = accountIdOfRow(row) ?? grant?.accountId;
      const checked = evaluateConnectorCall(grants, toolkit, normalizedCandidate, selectedAccount);
      if (!checked.ok) return denial(checked);
      nextRows.push(grant?.accountId ? pinAccountInRow(row, grant.accountId) : row);
    }
    return { ok: true, body: { ...rpc, params: { ...params, arguments: { ...args, tools: nextRows } } } };
  }

  const checked = decisionForTool(grants, name, args);
  if (!checked.result.ok) return checked.result;
  return {
    ok: true,
    body: { ...rpc, params: { ...params, ...(checked.args ? { arguments: checked.args } : {}) } },
  };
}

export interface ConnectorRequestItem {
  slug: string;
  alias?: string;
  accountId?: string;
}

/** Connection cards may not be used to bootstrap an ungranted toolkit. */
export function gateConnectorRequests(
  grants: ConnectorGrants | undefined,
  items: readonly ConnectorRequestItem[],
): ConnectorScopeGateResult {
  if (grants === undefined) return { ok: true, body: {} };
  for (const item of items) {
    const toolkit = item.slug.trim().toLowerCase();
    const grant = grantFor(grants, toolkit);
    if (!grant || grant.scopes.length === 0) {
      const decision: ConnectorCallDecision = { ok: false, reason: "toolkit", toolkit, toolName: "COMPOSIO_MANAGE_CONNECTIONS" };
      return denial(decision);
    }
    if (grant.accountId !== undefined && grant.accountId !== item.accountId) {
      const decision: ConnectorCallDecision = { ok: false, reason: "account", toolkit, toolName: "COMPOSIO_MANAGE_CONNECTIONS" };
      return denial(decision);
    }
  }
  return { ok: true, body: {} };
}

const MANAGEMENT_VISIBLE = new Set(["COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_WAIT_FOR_CONNECTIONS"]);
const DISCOVERY_VISIBLE = new Set([SEARCH_TOOL, SCHEMA_TOOL, EXECUTE_TOOL]);
const DISCOVERY_DROP = Symbol("connector-discovery-drop");

function filteredTools(tools: unknown[], grants: ConnectorGrants): unknown[] {
  return tools.filter((value) => {
    const row = object(value);
    const rawName = row && typeof row.name === "string" ? row.name : "";
    const name = bareToolName(rawName);
    if (MANAGEMENT_VISIBLE.has(name)) return true;
    if (DISCOVERY_VISIBLE.has(name)) return Object.keys(grants).length > 0;
    if (!rawName) return false;
    const toolkit = toolkitFor(grants, name);
    return evaluateConnectorCall(grants, toolkit, name, grantFor(grants, toolkit)?.accountId).ok;
  });
}

function rewriteJsonValue(value: unknown, grants: ConnectorGrants): unknown {
  const root = object(value);
  const result = root && object(root.result);
  if (!result || !Array.isArray(result.tools)) return value;
  return { ...root, result: { ...result, tools: filteredTools(result.tools, grants) } };
}

function discoveryToolName(row: JsonObject): string | undefined {
  for (const key of ["tool_slug", "tool_name", "toolName"]) {
    if (typeof row[key] === "string" && row[key].trim()) return row[key].trim();
  }
  if (typeof row.slug === "string" && /^[A-Za-z0-9]+_[A-Za-z0-9_]+$/.test(row.slug.trim())) return row.slug.trim();
  if (typeof row.name === "string" && /^[A-Za-z0-9]+_[A-Za-z0-9_]+$/.test(row.name.trim())) return row.name.trim();
  return undefined;
}

/** Search/schema results are usually returned as JSON inside an MCP text
 * content block. Filter that second discovery surface as well as tools/list;
 * otherwise a denied toolkit can still be advertised by a broad search. */
function filterDiscoveryValue(value: unknown, grants: ConnectorGrants): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const filtered = filterDiscoveryValue(item, grants);
      return filtered === DISCOVERY_DROP ? [] : [filtered];
    });
  }
  const row = object(value);
  if (!row) return value;
  const candidate = discoveryToolName(row);
  if (candidate) {
    const name = bareToolName(candidate);
    const toolkit = toolkitFor(grants, name);
    if (!evaluateConnectorCall(grants, toolkit, name, grantFor(grants, toolkit)?.accountId).ok) return DISCOVERY_DROP;
  }
  if (typeof row.toolkit === "string" && (Array.isArray(row.tools) || Array.isArray(row.actions)) && !grantFor(grants, row.toolkit.trim().toLowerCase())) {
    return DISCOVERY_DROP;
  }
  const next: JsonObject = {};
  for (const [key, child] of Object.entries(row)) {
    if (key === "text" && typeof child === "string") {
      try {
        const parsed = filterDiscoveryValue(JSON.parse(child), grants);
        next[key] = JSON.stringify(parsed === DISCOVERY_DROP ? {} : parsed);
        continue;
      } catch {
        // Non-JSON text is provider prose, not a structured discovery record.
      }
    }
    const filtered = filterDiscoveryValue(child, grants);
    if (filtered !== DISCOVERY_DROP) next[key] = filtered;
  }
  return next;
}

export function isConnectorDiscoveryCall(body: JsonObject): boolean {
  const params = paramsOf(body);
  return body.method === "tools/call" && typeof params.name === "string" &&
    new Set([SEARCH_TOOL, SCHEMA_TOOL]).has(bareToolName(params.name));
}

export function filterConnectorDiscoveryPayload(bytes: Uint8Array, contentType: string, grants: ConnectorGrants | undefined): Uint8Array {
  if (grants === undefined || !/json|event-stream/i.test(contentType)) return bytes;
  const text = new TextDecoder().decode(bytes);
  const rewrite = (value: unknown): unknown => filterDiscoveryValue(value, grants);
  if (/event-stream/i.test(contentType)) {
    const rewritten = text.split(/(\r?\n)/).map((line) => {
      if (!line.startsWith("data:")) return line;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") return line;
      try {
        const filtered = rewrite(JSON.parse(raw));
        return `data: ${JSON.stringify(filtered === DISCOVERY_DROP ? {} : filtered)}`;
      } catch { return line; }
    }).join("");
    return new TextEncoder().encode(rewritten);
  }
  try {
    const filtered = rewrite(JSON.parse(text));
    return new TextEncoder().encode(JSON.stringify(filtered === DISCOVERY_DROP ? {} : filtered));
  } catch {
    return new TextEncoder().encode(text);
  }
}

/** Filter tools/list responses so explicit deny-all grants do not advertise execution. */
export function filterConnectorToolsPayload(bytes: Uint8Array, contentType: string, grants: ConnectorGrants | undefined): Uint8Array {
  if (grants === undefined || !/json|event-stream/i.test(contentType)) return bytes;
  const text = new TextDecoder().decode(bytes);
  if (/event-stream/i.test(contentType)) {
    const rewritten = text.split(/(\r?\n)/).map((line) => {
      if (!line.startsWith("data:")) return line;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") return line;
      try { return `data: ${JSON.stringify(rewriteJsonValue(JSON.parse(raw), grants))}`; } catch { return line; }
    }).join("");
    return new TextEncoder().encode(rewritten);
  }
  try {
    return new TextEncoder().encode(JSON.stringify(rewriteJsonValue(JSON.parse(text), grants)));
  } catch {
    // A malformed upstream response must not become a new discovery path.
    return new TextEncoder().encode(text);
  }
}
