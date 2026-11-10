// The Composio backend, behind the ConnectorProvider seam: a person's own project (ak_ key) or the
// managed connected-apps service. Behavior and shapes are unchanged from when this code lived in
// server/composio.ts; only the import paths and the provider wrapper are new.
import type { AppConfig } from "../config.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { managedConnectorUnavailableReason, managedCustomAuthReason } from "../../shared/connector-availability.ts";
import {
  listConnectedAccounts,
  MAX_CONNECTED_ACCOUNT_PAGES,
  type ConnectedAccountResponse,
  DEFAULT_BACKEND_ORIGIN,
  apiBase,
  canonicalToolkitSlug,
  inputError,
  keepAuthConfigPick,
  noAuthConfigReason,
  projectHeaders,
  refusedAuthConfigReason,
  responseError,
} from "../composio-project.ts";
import { MULTI_ACCOUNT_CONFIG, authConfigRefusal, ensureProjectSession, projectApiKey, sessionForToolkit } from "../composio-session.ts";
import { inventoryAccountSchema, toolkitInventoryPageSchema } from "../composio-inventory-schema.ts";
import { authConfigUseLine, noManagedAuthToolkit, withNoManagedAuthNote } from "../connector-auth-config-hint.ts";
import { planAccountLink } from "../../shared/connector-account-link.ts";
import { CONNECTOR_TOOL_NAME_PATTERN } from "../../shared/wire.ts";
import { brokerAccess, type BrokerAccess } from "../composio-broker-access.ts";
import { serviceSlugFor, serviceSlugForCandidates } from "../connector-verdict.ts";
import { parseMcpResponse, withToolsListFallback } from "../connector-tools-list.ts";
import { canonicalServiceRecord, normalizeAccountAlias, printableAliasSchema, requestedServiceRecord, toolkitCategories } from "./common.ts";
import { CURATED } from "./catalog.ts";
import type {
  CatalogPagination,
  CatalogStopReason,
  ConnectedServicesInventory,
  ConnectorAuthItem,
  ConnectorCatalog,
  ConnectorProvider,
  ConnectorServiceState,
  ConnectorToolListing,
  JsonValue,
  ToolkitCard,
} from "./types.ts";

function toolkitBase() {
  return (process.env.OMB_COMPOSIO_TOOLKITS_API ?? `${DEFAULT_BACKEND_ORIGIN}/api/v3`).replace(/\/$/, "");
}

interface AccountLinkRequest {
  toolkit: string;
  alias?: string;
}


const toolkitItemSchema = z.object({
  slug: z.string().optional(),
  is_no_auth: z.boolean().optional(),
  connected_account: z.object({ id: z.string().optional(), status: z.string().optional() }).nullable().optional(),
});
type ToolkitItem = z.infer<typeof toolkitItemSchema>;
const toolkitPageSchema = z.object({
  items: z.array(toolkitItemSchema).optional(),
  next_cursor: z.string().nullable().optional(),
});

const connectorServiceSchema = z.object({
  connected: z.boolean(),
  pending: z.boolean().optional(),
  status: z.string().optional(),
  accounts: z.array(z.object({ id: z.string(), alias: z.string().optional(), status: z.string() })).optional(),
});
const connectorServicesResponseSchema = z.object({ services: z.record(z.string(), connectorServiceSchema).optional(), complete: z.boolean().optional() });
const removalResponseSchema = z.object({ removed: z.number() });
const authUrlResponseSchema = z.object({ url: z.string().optional() });
const linkResponseSchema = z.object({ redirect_url: z.string().optional() });

const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Separates caches and transports per credential without keeping another plaintext copy of it. */
function backendFingerprint(kind: string, endpoint: string, credential: string): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(endpoint)
    .update("\0")
    .update(credential)
    .digest("hex");
}

const MAX_TRACKED_TRANSPORT_SESSIONS = 512;
const transportSessionBackends = new Map<string, string>();

function rememberTransportSession(sessionId: string, identity: string): void {
  transportSessionBackends.delete(sessionId);
  transportSessionBackends.set(sessionId, identity);
  while (transportSessionBackends.size > MAX_TRACKED_TRANSPORT_SESSIONS) {
    const oldest = transportSessionBackends.keys().next().value;
    if (oldest === undefined) break;
    transportSessionBackends.delete(oldest);
  }
}

function connectionModeFor(cfg: AppConfig): "managed" | "self-hosted" | "unavailable" {
  if (projectApiKey(cfg)) return "self-hosted";
  if (brokerAccess()) return "managed";
  return "unavailable";
}

function configuredFor(cfg: AppConfig): boolean {
  return connectionModeFor(cfg) !== "unavailable";
}

async function brokerRequest(path: string, init?: RequestInit, broker = brokerAccess()): Promise<Response> {
  if (!broker) throw new Error("The connected-apps service is unavailable");
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${broker.token}`);
  if (init?.body) headers.set("content-type", "application/json");
  return fetch(`${broker.url}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
}

async function throwBrokerError(res: Response, fallback: string): Promise<never> {
  const status = res.status >= 400 && res.status < 500 ? res.status : 502;
  throw Object.assign(new Error(await responseError(res, fallback)), { status });
}

function trustedAuthUrl(value: string | undefined, slug: string): string {
  if (!value) throw new Error(`Connected-apps service returned no authorization link for ${slug}`);
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "composio.dev" && !url.hostname.endsWith(".composio.dev"))) {
    throw new Error("Connected-apps service returned an untrusted authorization link");
  }
  return url.toString();
}

function validAccountId(value: string | undefined): value is string {
  return Boolean(value && ACCOUNT_ID.test(value));
}

/** Composio's wording when a toolkit needs one of the project's own auth configs. */
const NEEDS_AUTH_CONFIG = /does not manage auth|auth[_ ]?config/i;

export async function relayMcp(
  cfg: AppConfig,
  payload: JsonValue,
  transportSessionId?: string,
  beforeSend?: () => void, signal?: AbortSignal, as?: BrokerAccess,
): Promise<{ status: number; bytes: Uint8Array; contentType: string; transportSessionId?: string }> {
  const apiKey = as ? null : projectApiKey(cfg);
  let url: string;
  let identity: string;
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (apiKey) {
    const session = await ensureProjectSession(cfg);
    url = session.mcp.url;
    headers.set("x-api-key", apiKey);
    identity = backendFingerprint("project-mcp", url, apiKey);
  } else {
    const broker = as ?? brokerAccess();
    if (!broker) throw new Error("Connected apps are unavailable");
    url = `${broker.url}/v1/mcp`;
    headers.set("authorization", `Bearer ${broker.token}`);
    identity = backendFingerprint("managed-mcp", url, broker.token);
  }
  const knownIdentity = transportSessionId
    ? transportSessionBackends.get(transportSessionId)
    : undefined;
  const forwardedTransportSessionId = transportSessionId
    && knownIdentity === identity
    ? transportSessionId
    : undefined;
  if (forwardedTransportSessionId) {
    headers.set("mcp-session-id", forwardedTransportSessionId);
  }
  // Discovery may await I/O: check turn authority and permissions after it, right before dispatch.
  beforeSend?.();
  const response = await withToolsListFallback(identity, payload, () => fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: signal ?? AbortSignal.timeout(10 * 60_000),
  }));
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw.byteLength > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  if (forwardedTransportSessionId) rememberTransportSession(forwardedTransportSessionId, identity);
  const nextTransportSessionId = response.headers.get("mcp-session-id") ?? undefined;
  if (nextTransportSessionId) rememberTransportSession(nextTransportSessionId, identity);
  const contentType = response.headers.get("content-type") ?? "application/json";
  const toolCall = typeof payload === "object" && payload !== null && !Array.isArray(payload) && payload.method === "tools/call";
  const toolkit = toolCall ? noManagedAuthToolkit(new TextDecoder().decode(raw)) : null;
  const bytes = toolkit
    ? await withNoManagedAuthNote(raw, contentType, toolkit, apiKey ? () => sessionForToolkit(cfg, toolkit, { fresh: true }) : null)
    : raw;
  return { status: response.status, bytes, contentType, transportSessionId: nextTransportSessionId };
}

/** The local MCP-proxy spawn a bot's engine runs stays on the facade (server/composio.ts): the bridge
 * shape is provider-agnostic, and only the service-slug env it may carry comes from the provider. */


async function listSessionToolkits(
  apiKey: string,
  sessionId: string,
): Promise<{ items: ToolkitItem[]; complete: boolean }> {
  const items: ToolkitItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let complete = true;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    // Unfiltered, this endpoint pages through the whole marketplace 50 at a time.
    const params = new URLSearchParams({ limit: "50", is_connected: "true" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(
      `${apiBase()}/tool_router/session/${encodeURIComponent(sessionId)}/toolkits?${params}`,
      { headers: projectHeaders(apiKey), signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error(await responseError(response, `Composio toolkits: HTTP ${response.status}`));
    const raw: unknown = await response.json();
    const body = toolkitPageSchema.parse(raw);
    items.push(...(body.items ?? []));
    complete &&= toolkitInventoryPageSchema.safeParse(raw).success;
    const next = body.next_cursor || undefined;
    if (!next) return { items, complete };
    if (seenCursors.has(next)) return { items, complete: false };
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Composio toolkit inventory exceeded the pagination safety limit");
}

interface AccountSummary {
  id: string;
  alias?: string;
  status: string;
}

function summarizeAccounts(accounts: ConnectedAccountResponse[], slugs: string[]) {
  const requested = new Set(slugs.map(canonicalToolkitSlug));
  const bySlug = new Map<string, Array<AccountSummary & { updatedAt: string }>>();
  for (const account of accounts) {
    const slug = account.toolkit?.slug ? canonicalToolkitSlug(account.toolkit.slug) : "";
    if (!slug || (requested.size && !requested.has(slug)) || !validAccountId(account.id)) continue;
    const alias = account.alias?.trim() ?? "";
    const summary: AccountSummary & { updatedAt: string } = {
      id: account.id,
      status: account.status || "UNKNOWN",
      updatedAt: account.updated_at ?? "",
    };
    if (printableAliasSchema.safeParse(alias).success) summary.alias = alias;
    const list = bySlug.get(slug) ?? [];
    list.push(summary);
    bySlug.set(slug, list);
  }
  for (const list of bySlug.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return bySlug;
}

function publicAccount({ id, alias, status }: AccountSummary): AccountSummary {
  const account: AccountSummary = { id, status };
  if (alias) account.alias = alias;
  return account;
}

function serviceStateFromAccounts(
  accounts: AccountSummary[],
): ConnectorServiceState {
  const active = accounts.find((account) => /^active$/i.test(account.status));
  const pending = accounts.find((account) => /^(initiated|initializing|pending)$/i.test(account.status));
  const selected = active ?? pending ?? accounts[0];
  return {
    connected: Boolean(active),
    pending: Boolean(pending),
    status: selected?.status ?? "not_connected",
    accounts: accounts.map(publicAccount),
  };
}

function allServiceStates(
  accountsBySlug: ReadonlyMap<string, AccountSummary[]>,
  toolkits: ToolkitItem[],
): Record<string, ConnectorServiceState> {
  const services = new Map(
    [...accountsBySlug].map(([slug, accounts]) => [slug, serviceStateFromAccounts(accounts)]),
  );
  for (const toolkit of toolkits) {
    const slug = toolkit.slug ? canonicalToolkitSlug(toolkit.slug) : "";
    const selected = toolkit.connected_account;
    const selectedId = validAccountId(selected?.id) ? selected.id : undefined;
    if (!slug || (!toolkit.is_no_auth && !selectedId)) continue;
    const existingAccounts = accountsBySlug.get(slug) ?? [];
    const accounts = [...existingAccounts];
    if (selectedId && !accounts.some((account) => account.id === selectedId)) {
      accounts.push({ id: selectedId, status: selected?.status ?? "ACTIVE" });
    }
    const accountState = serviceStateFromAccounts(accounts);
    const status = toolkit.is_no_auth ? "ACTIVE" : selected?.status ?? accountState.status;
    services.set(slug, {
      connected: toolkit.is_no_auth === true || accountState.connected || /^active$/i.test(status),
      pending: accountState.pending || /^(initiated|initializing|pending)$/i.test(status),
      status,
      accounts: accountState.accounts,
    });
  }
  return Object.fromEntries(services);
}

async function connectedServicesInventory(cfg: AppConfig, as?: BrokerAccess): Promise<ConnectedServicesInventory> {
  const apiKey = as ? null : projectApiKey(cfg);
  if (!apiKey) {
    const response = await brokerRequest("/v1/connectors/connected", undefined, as);
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    const body = connectorServicesResponseSchema.required({ services: true }).parse(await response.json());
    const services = canonicalServiceRecord(body.services);
    return {
      services: Object.fromEntries(
        Object.entries(services).map(([slug, state]) => [slug, {
          connected: state.connected,
          pending: state.pending ?? false,
          status: state.status ?? (state.connected ? "ACTIVE" : "not_connected"),
          accounts: state.accounts ?? [],
        }]),
      ),
      // A broker that predates this field sends none, so only an explicit false means its account read came up short.
      complete: body.complete !== false,
    };
  }
  const session = await ensureProjectSession(cfg);
  const userId = session.config?.user_id ?? cfg.composio?.userId;
  if (!userId) throw new Error("Composio Session returned no user ID");
  const [toolkits, accountResult] = await Promise.all([
    listSessionToolkits(apiKey, session.session_id),
    // Scoped project keys can grant Session reads without the raw connected-account list.
    listConnectedAccounts(apiKey, userId, []).then((accounts) => ({ accounts, complete: accounts.every((account) => inventoryAccountSchema.safeParse(account).success) }))
      .catch(() => ({ accounts: [] as ConnectedAccountResponse[], complete: false as const })),
  ]);
  return {
    services: allServiceStates(summarizeAccounts(accountResult.accounts, []), toolkits.items),
    complete: accountResult.complete && toolkits.complete,
  };
}

async function connectedServices(cfg: AppConfig, as?: BrokerAccess): Promise<Record<string, ConnectorServiceState>> {
  return (await connectedServicesInventory(cfg, as)).services;
}

/** Cache the session-derived backend key briefly, so a cache hit does not make a Session request.
 * A failed key lookup gets a one-shot identity that can never match earlier data. */
const CONNECTOR_IDENTITY_CACHE_MS = 60_000;
const connectorIdentityCache = new Map<string, { at: number; identity: string }>();
let connectorIdentityFailure = 0;

async function connectorToolsIdentity(cfg: AppConfig, as?: BrokerAccess): Promise<string> {
  const apiKey = as ? null : projectApiKey(cfg);
  const broker = as ?? brokerAccess();
  const rawKey = backendFingerprint(
    "connector-identity", apiBase(),
    [apiKey ?? "", broker?.url ?? "", broker?.token ?? "",
      ...(apiKey ? [cfg.composio?.sessionId ?? "", cfg.composio?.userId ?? ""] : [])].join("\0"),
  );
  const cached = connectorIdentityCache.get(rawKey);
  if (cached && Date.now() - cached.at < CONNECTOR_IDENTITY_CACHE_MS) return cached.identity;
  try {
    const identity = apiKey
      ? backendFingerprint("project-tools", apiBase(), `${apiKey}\0${(await ensureProjectSession(cfg)).session_id}`)
      : broker ? backendFingerprint("managed-tools", broker.url, broker.token) : "none";
    if (connectorIdentityCache.size > 100) connectorIdentityCache.clear();
    connectorIdentityCache.set(rawKey, { at: Date.now(), identity });
    return identity;
  } catch {
    return `unavailable:${++connectorIdentityFailure}`;
  }
}

const CONNECTOR_TOOLS_CACHE_MS = 60_000;
let connectorToolsCache: { at: number; identity: string; services: Record<string, ConnectorToolListing[]> } | null = null;
let connectorToolsRequest: { identity: string; services: Promise<Record<string, ConnectorToolListing[]>> } | null = null;

/** The picker offers exactly what a granted bot's bridge would see. */
async function listConnectorTools(
  cfg: AppConfig,
  options: { force?: boolean } = {},
): Promise<Record<string, ConnectorToolListing[]>> {
  const identity = await connectorToolsIdentity(cfg);
  if (!options.force && connectorToolsCache?.identity === identity
    && Date.now() - connectorToolsCache.at < CONNECTOR_TOOLS_CACHE_MS) {
    return connectorToolsCache.services;
  }
  if (connectorToolsRequest?.identity === identity) return connectorToolsRequest.services;
  const walk = collectConnectorTools(cfg).then((services) => {
    connectorToolsCache = { at: Date.now(), identity, services };
    return services;
  });
  connectorToolsRequest = { identity, services: walk };
  try {
    return await walk;
  } finally {
    if (connectorToolsRequest?.services === walk) connectorToolsRequest = null;
  }
}

const CONNECTOR_SERVICE_SLUGS_CACHE_MS = 60_000;
let connectorServiceSlugsCache: {
  at: number;
  identity: string;
  baseIdentity: string;
  sessionId?: string;
  slugs: readonly string[];
} | null = null;
const connectorServiceSlugsRequests = new Map<string, Promise<readonly string[]>>();

function connectorServiceCacheIdentity(cfg: AppConfig, as?: BrokerAccess): string {
  const apiKey = as ? null : projectApiKey(cfg);
  if (apiKey) return backendFingerprint("project-slugs", apiBase(), apiKey);
  const broker = as ?? brokerAccess();
  return broker ? backendFingerprint("managed-slugs", broker.url, broker.token) : "none";
}

/** Real backend slugs, so an underscored service (bland_ai) is never captured by a plain-prefix grant
 * (bland); a failed read answers the last good one. A valid cache hit never wakes the Session. */
async function connectedServiceSlugs(cfg: AppConfig, as?: BrokerAccess): Promise<readonly string[]> {
  const apiKey = as ? null : projectApiKey(cfg);
  const baseIdentity = connectorServiceCacheIdentity(cfg, as);
  const cache = connectorServiceSlugsCache;
  const cacheSessionMatches = !apiKey || cfg.composio?.sessionId === cache?.sessionId;
  if (cache && cache.baseIdentity === baseIdentity && cacheSessionMatches
    && Date.now() - cache.at < CONNECTOR_SERVICE_SLUGS_CACHE_MS) {
    return cache.slugs;
  }
  if (!apiKey) {
    const existing = connectorServiceSlugsRequests.get(baseIdentity);
    if (existing) return existing;
  }
  let request: Promise<readonly string[]> | undefined;
  const walk = (async (): Promise<readonly string[]> => {
    if (!apiKey) await Promise.resolve();
    let identity = baseIdentity;
    let sessionId = apiKey ? cfg.composio?.sessionId : undefined;
    try {
      if (apiKey) {
        const session = await ensureProjectSession(cfg);
        sessionId = session.session_id;
        identity = backendFingerprint("project-tools", apiBase(), `${apiKey}\0${sessionId}`);
      }
      const existing = connectorServiceSlugsRequests.get(identity);
      if (existing) return existing;
      connectorServiceSlugsRequests.set(identity, request!);
      const services = await connectedServices(cfg, as);
      const slugs = Object.keys(services);
      connectorServiceSlugsCache = { at: Date.now(), identity, baseIdentity, ...(sessionId ? { sessionId } : {}), slugs };
      return slugs;
    } catch {
      const stale = connectorServiceSlugsCache;
      const sameSession = !apiKey || sessionId === stale?.sessionId;
      if (stale && (stale.identity === identity || stale.baseIdentity === baseIdentity) && sameSession) return stale.slugs;
      return [] as readonly string[];
    } finally {
      const active = connectorServiceSlugsRequests.get(identity);
      if (active === request) connectorServiceSlugsRequests.delete(identity);
    }
  })();
  request = walk;
  try {
    return await walk;
  } finally {
    for (const [identity, active] of connectorServiceSlugsRequests) {
      if (active === request) connectorServiceSlugsRequests.delete(identity);
    }
  }
}

const TOOL_DESCRIPTION_MAX = 240;
const TOOLS_LIST_PAGES_MAX = 10;

function connectorToolListing(tool: unknown): ConnectorToolListing | null {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
  const name = (tool as { name?: unknown }).name;
  if (typeof name !== "string" || !CONNECTOR_TOOL_NAME_PATTERN.test(name)) return null;
  if (name.startsWith("COMPOSIO_")) return null;
  if (name.endsWith("_MANAGE_CONNECTIONS") || name.endsWith("_WAIT_FOR_CONNECTIONS")) return null;
  const description = (tool as { description?: unknown }).description;
  const trimmed = typeof description === "string"
    ? description.replace(/\s+/g, " ").trim().slice(0, TOOL_DESCRIPTION_MAX)
    : "";
  return trimmed ? { name, description: trimmed } : { name };
}

async function collectConnectorTools(cfg: AppConfig): Promise<Record<string, ConnectorToolListing[]>> {
  const candidates = await connectedServiceSlugs(cfg);
  const initialize = await relayMcp(cfg, {
    jsonrpc: "2.0",
    id: "omb-grants-initialize",
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "openmausbot-grant-editor", version: "1" },
    },
  });
  if (initialize.status !== 200) {
    throw new Error(await responseErrorFromBytes(initialize.status, initialize.bytes));
  }
  const transportSessionId = initialize.transportSessionId;
  // Streamable-HTTP MCP servers expect the initialized notification before the first request.
  await relayMcp(cfg, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }, transportSessionId).catch(() => undefined);
  const grouped = new Map<string, ConnectorToolListing[]>();
  let cursor: string | undefined;
  for (let page = 0; page < TOOLS_LIST_PAGES_MAX; page += 1) {
    const list = await relayMcp(cfg, {
      jsonrpc: "2.0",
      id: "omb-grants-tools",
      method: "tools/list",
      params: cursor ? { cursor } : {},
    }, transportSessionId);
    if (list.status !== 200) {
      throw new Error(await responseErrorFromBytes(list.status, list.bytes));
    }
    const frame = parseMcpResponse(new TextDecoder().decode(list.bytes), "omb-grants-tools");
    const error = frame && typeof frame.error === "object" && frame.error !== null
      ? (frame.error as { message?: unknown }).message
      : undefined;
    if (typeof error === "string" && error) throw new Error(error);
    const result = frame && typeof frame.result === "object" && frame.result !== null
      ? (frame.result as { tools?: unknown; nextCursor?: unknown })
      : undefined;
    if (!result || !Array.isArray(result.tools)) {
      throw new Error("Composio returned a tools/list response without a tools array");
    }
    for (const tool of result.tools) {
      const listing = connectorToolListing(tool);
      if (!listing) continue;
      const slug = serviceSlugForCandidates(listing.name, candidates) ?? serviceSlugFor(listing.name);
      if (!slug) continue;
      const bucket = grouped.get(slug) ?? [];
      if (!bucket.some((existing) => existing.name === listing.name)) bucket.push(listing);
      grouped.set(slug, bucket);
    }
    cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  if (cursor) throw new Error("Composio tools list exceeded the pagination safety limit");
  for (const bucket of grouped.values()) bucket.sort((a, b) => a.name.localeCompare(b.name));
  return Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function responseErrorFromBytes(status: number, bytes: Uint8Array): Promise<string> {
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const message = body && typeof body === "object" && !Array.isArray(body)
      ? (body as { error?: unknown }).error
      : undefined;
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const text = (message as { message?: unknown }).message;
      if (typeof text === "string" && text) return text;
    }
    if (typeof message === "string" && message) return message;
  } catch {
  }
  return `Composio tools/list: HTTP ${status}`;
}

async function connectionStatus(cfg: AppConfig, slugs: string[]): Promise<Record<string, ConnectorServiceState>> {
  const canonicalSlugs = [...new Set(slugs.map(canonicalToolkitSlug))];
  const apiKey = projectApiKey(cfg);
  if (!apiKey) {
    const response = await brokerRequest(`/v1/connectors?${new URLSearchParams({ services: canonicalSlugs.join(",") })}`);
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    const body = connectorServicesResponseSchema.parse(await response.json());
    const services = canonicalServiceRecord(body.services ?? {});
    return requestedServiceRecord(Object.fromEntries(
      Object.entries(services).map(([slug, state]) => [slug, {
        connected: state.connected,
        pending: state.pending ?? false,
        status: state.status ?? (state.connected ? "ACTIVE" : "not_connected"),
        accounts: state.accounts ?? [],
      }]),
    ), slugs);
  }
  const session = await ensureProjectSession(cfg);
  const userId = session.config?.user_id ?? cfg.composio?.userId;
  const bySlug = new Map<string, ToolkitItem>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: "50" });
    if (canonicalSlugs.length) params.set("toolkits", canonicalSlugs.join(","));
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(session.session_id)}/toolkits?${params}`, {
      headers: projectHeaders(apiKey),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(await responseError(res, `Composio toolkits: HTTP ${res.status}`));
    const body = toolkitPageSchema.parse(await res.json());
    for (const item of body.items ?? []) {
      if (!item.slug) continue;
      bySlug.set(canonicalToolkitSlug(item.slug), item);
    }
    const next = body.next_cursor || undefined;
    if (!next) {
      cursor = undefined;
      break;
    }
    if (seenCursors.has(next)) throw new Error("Composio status inventory repeated a pagination cursor");
    seenCursors.add(next);
    cursor = next;
  }
  if (cursor) throw new Error("Composio status inventory exceeded the pagination safety limit");
  const accounts = userId
    ? await listConnectedAccounts(apiKey, userId, canonicalSlugs).catch(() => [])
    : [];
  const accountsBySlug = summarizeAccounts(accounts, canonicalSlugs);
  return Object.fromEntries(
    slugs.map((slug) => {
      const canonicalSlug = canonicalToolkitSlug(slug);
      const item = bySlug.get(canonicalSlug);
      const serviceAccounts = accountsBySlug.get(canonicalSlug) ?? [];
      const selected = item?.connected_account;
      const selectedId = validAccountId(selected?.id) ? selected.id : undefined;
      const withSelected = selectedId && !serviceAccounts.some((account) => account.id === selectedId)
        ? [...serviceAccounts, { id: selectedId, status: selected?.status ?? "ACTIVE" }]
        : serviceAccounts;
      const accountState = serviceStateFromAccounts(withSelected);
      const state = item?.connected_account?.status
        ?? (item?.is_no_auth ? "ACTIVE" : accountState.status);
      return [slug, {
        connected: item?.is_no_auth === true || accountState.connected || /^active$/i.test(state),
        pending: accountState.pending || /^(initiated|initializing|pending)$/i.test(state),
        status: state,
        accounts: accountState.accounts,
      }];
    }),
  );
}

async function removeService(cfg: AppConfig, slug: string, as?: BrokerAccess) {
  const toolkit = canonicalToolkitSlug(slug);
  const apiKey = as ? null : projectApiKey(cfg);
  if (!apiKey) {
    const response = await brokerRequest(`/v1/connectors/${encodeURIComponent(toolkit)}`, { method: "DELETE" }, as);
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    return removalResponseSchema.parse(await response.json());
  }
  const session = await ensureProjectSession(cfg);
  const params = new URLSearchParams({ limit: "50", toolkits: toolkit });
  const list = await fetch(
    `${apiBase()}/tool_router/session/${encodeURIComponent(session.session_id)}/toolkits?${params}`,
    { headers: projectHeaders(apiKey), signal: AbortSignal.timeout(15_000) },
  );
  if (!list.ok) throw new Error(await responseError(list, `Composio toolkits: HTTP ${list.status}`));
  const body = toolkitPageSchema.parse(await list.json());
  const id = body.items?.find((item) => item.slug && canonicalToolkitSlug(item.slug) === toolkit)?.connected_account?.id;
  if (!id) return { removed: 0 };
  await deleteConnectedAccount(apiKey, id);
  return { removed: 1 };
}

async function deleteConnectedAccount(apiKey: string, id: string) {
  const removed = await fetch(
    `${apiBase()}/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`,
    { method: "DELETE", headers: projectHeaders(apiKey), signal: AbortSignal.timeout(30_000) },
  );
  if (!removed.ok) throw new Error(await responseError(removed, `Composio disconnect: HTTP ${removed.status}`));
}

/** Disconnect exactly one account after proving it belongs to this user/toolkit. */
async function removeAccount(cfg: AppConfig, slug: string, accountId: string) {
  if (!validAccountId(accountId)) throw inputError("Invalid connected-account ID");
  const toolkit = canonicalToolkitSlug(slug);
  const apiKey = projectApiKey(cfg);
  if (!apiKey) {
    const response = await brokerRequest(
      `/v1/connectors/${encodeURIComponent(toolkit)}/accounts/${encodeURIComponent(accountId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    return removalResponseSchema.parse(await response.json());
  }
  const session = await ensureProjectSession(cfg);
  const userId = session.config?.user_id ?? cfg.composio?.userId;
  if (!userId) throw new Error("Composio Session has no user ID");
  const accounts = await listConnectedAccounts(apiKey, userId, [toolkit]);
  const owned = accounts.some((account) =>
    account.id === accountId
      && account.toolkit?.slug !== undefined
      && canonicalToolkitSlug(account.toolkit.slug) === toolkit
  );
  if (!owned) return { removed: 0 };
  await deleteConnectedAccount(apiKey, accountId);
  return { removed: 1 };
}

/** Readies a bot's connection request before its cards show: an auth config the bot named is checked in the person's own
 * project and kept, and each toolkit's own config is named in the Session. Returns which config each toolkit uses. */
async function prepareConnectionAuthConfigs(
  cfg: AppConfig,
  items: ReadonlyArray<ConnectorAuthItem>,
): Promise<string | undefined> {
  const apiKey = projectApiKey(cfg);
  for (const { slug, authConfigId } of items) {
    if (!authConfigId) continue;
    const toolkit = canonicalToolkitSlug(slug);
    if (!apiKey) throw inputError(managedCustomAuthReason(toolkit), 409);
    await keepAuthConfigPick(apiKey, toolkit, authConfigId);
  }
  if (!apiKey) return undefined;
  const lines: string[] = [];
  for (const toolkit of new Set(items.map(({ slug }) => canonicalToolkitSlug(slug)))) {
    // A config Composio won't take yet still gets its card: Connect then says why.
    const { choice } = await sessionForToolkit(cfg, toolkit).catch(() => ({ choice: null }));
    if (choice) lines.push(authConfigUseLine(toolkit, choice));
  }
  return lines.length ? lines.join(" ") : undefined;
}

async function authorizeService(cfg: AppConfig, slug: string, requestedAlias?: string | null, as?: BrokerAccess) {
  const alias = normalizeAccountAlias(requestedAlias);
  const toolkit = canonicalToolkitSlug(slug);
  const unavailable = managedConnectorUnavailableReason(as ? "managed" : connectionModeFor(cfg), toolkit);
  if (unavailable) throw inputError(unavailable, 409);
  const apiKey = as ? null : projectApiKey(cfg);
  if (!apiKey) {
    const request: RequestInit = { method: "POST" };
    if (alias) request.body = JSON.stringify({ alias });
    const response = await brokerRequest(`/v1/connectors/${encodeURIComponent(toolkit)}/authorize`, request, as);
    if (!response.ok && noManagedAuthToolkit(await response.clone().text().catch(() => ""))) {
      throw inputError(managedCustomAuthReason(toolkit), 409);
    }
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    const body = authUrlResponseSchema.parse(await response.json());
    return { url: trustedAuthUrl(body.url, toolkit) };
  }
  const { session } = await sessionForToolkit(cfg, toolkit);
  const userId = session.config?.user_id ?? cfg.composio?.userId;
  if (!userId) throw new Error("Composio Session has no user ID");
  const accounts = await listConnectedAccounts(apiKey, userId, [toolkit]);
  const serviceAccounts = accounts.filter((account) =>
    account.toolkit?.slug !== undefined && canonicalToolkitSlug(account.toolkit.slug) === toolkit
  );
  const plan = planAccountLink(toolkit, serviceAccounts, alias, MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit, () => `omb-retry-${randomUUID()}`);
  if (!plan.ok) throw inputError(plan.error, plan.status);
  for (const id of plan.replace) await deleteConnectedAccount(apiKey, id);
  const linkRequest: AccountLinkRequest = { toolkit };
  if (plan.alias) linkRequest.alias = plan.alias;
  const link = (sessionId: string) =>
    fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(sessionId)}/link`, {
      method: "POST",
      headers: projectHeaders(apiKey, true),
      body: JSON.stringify(linkRequest),
      signal: AbortSignal.timeout(30_000),
    });
  let res = await link(session.session_id);
  if (!res.ok) {
    const message = await responseError(res, `Composio authorization: HTTP ${res.status}`);
    if (!NEEDS_AUTH_CONFIG.test(message)) throw new Error(message);
    const fresh = await sessionForToolkit(cfg, toolkit, { fresh: true });
    if (!fresh.choice) {
      if (fresh.readError) throw new Error(`Composio auth configs: ${fresh.readError}`);
      throw inputError(noAuthConfigReason(toolkit));
    }
    res = await link(fresh.session.session_id);
    if (!res.ok) {
      const again = await responseError(res, `Composio authorization: HTTP ${res.status}`);
      if (!NEEDS_AUTH_CONFIG.test(again)) throw new Error(again);
      throw inputError(refusedAuthConfigReason(toolkit, authConfigRefusal(fresh.choice.id) ?? again));
    }
  }
  const body = linkResponseSchema.parse(await res.json());
  return { url: trustedAuthUrl(body.redirect_url, toolkit) };
}

let toolkitCache: { at: number; cards: ToolkitCard[]; identity: string; pagination: CatalogPagination } | null = null;

async function listToolkits(cfg: AppConfig): Promise<ConnectorCatalog> {
  const backendKey = projectApiKey(cfg);
  const broker = backendKey ? null : brokerAccess();
  const identity = backendKey
    ? backendFingerprint("project-catalog", toolkitBase(), backendKey)
    : broker
      ? backendFingerprint("managed-catalog", broker.url, broker.token)
      : null;
  if (identity && toolkitCache?.identity === identity && Date.now() - toolkitCache.at < 10 * 60_000) {
    return { cards: toolkitCache.cards, source: "api", pagination: toolkitCache.pagination };
  }
  if (backendKey || broker) {
    try {
      const items: any[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let lastReportedPage: number | undefined;
      let reportedTotalItems: number | undefined;
      let reportedTotalPages: number | undefined;
      let stop: CatalogStopReason = "limit";
      for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
        const params = new URLSearchParams({ limit: "500", sort_by: "usage" });
        if (cursor) params.set("cursor", cursor);
        const res = backendKey
          ? await fetch(`${toolkitBase()}/toolkits?${params}`, {
              headers: { "x-api-key": backendKey },
              signal: AbortSignal.timeout(15_000),
            })
          : await brokerRequest(cursor ? `/v1/catalog?cursor=${encodeURIComponent(cursor)}` : "/v1/catalog", {
              signal: AbortSignal.timeout(15_000),
            });
        if (!res.ok) {
          stop = "http-error";
          break;
        }
        const json: any = await res.json();
        const pageItems = json.items ?? json.data ?? [];
        if (!Array.isArray(pageItems)) {
          stop = "bad-page";
          break;
        }
        items.push(...pageItems);
        const pageTotalItems = Number(json.total_items);
        if (Number.isFinite(pageTotalItems) && pageTotalItems > 0) reportedTotalItems = pageTotalItems;
        // A broker that drops the cursor can replay a page while minting fresh cursors, so trust Composio's current_page movement.
        const reportedPage = Number(json.current_page);
        if (Number.isFinite(reportedPage)) {
          if (lastReportedPage !== undefined && reportedPage <= lastReportedPage) {
            stop = "page-stuck";
            break;
          }
          lastReportedPage = reportedPage;
        }
        const pageTotalPages = Number(json.total_pages);
        if (Number.isFinite(pageTotalPages) && pageTotalPages > 0) reportedTotalPages = pageTotalPages;
        if (
          lastReportedPage !== undefined &&
          Number.isFinite(pageTotalPages) &&
          pageTotalPages > 0 &&
          lastReportedPage >= pageTotalPages
        ) {
          stop = "total-reached";
          break;
        }
        const next = typeof json.next_cursor === "string" ? json.next_cursor.trim() : "";
        if (!next) {
          stop = "end";
          break;
        }
        if (seenCursors.has(next)) {
          stop = "cursor-repeated";
          break;
        }
        seenCursors.add(next);
        cursor = next;
      }
      if (items.length) {
        const cards: ToolkitCard[] = items.map((t: any) => ({
          slug: canonicalToolkitSlug(String(t.slug ?? t.key ?? t.name ?? "")),
          label: t.name ?? t.slug ?? "",
          blurb: (t.meta?.description ?? t.description ?? "").slice(0, 90),
          logo: t.meta?.logo ?? t.logo ?? null,
          noAuth: t.no_auth === true,
          domain: null,
          ...(toolkitCategories(t.meta?.categories) ? { categories: toolkitCategories(t.meta?.categories) } : {}),
        }));
        const uniqueCards = cards.filter(
          (card, index) => card.slug && cards.findIndex((candidate) => candidate.slug === card.slug) === index,
        );
        const shortOfReportedTotal = reportedTotalItems !== undefined && uniqueCards.length < reportedTotalItems;
        const pagingStoppedEarly = lastReportedPage !== undefined
          && reportedTotalPages !== undefined
          && lastReportedPage < reportedTotalPages;
        const stalled = shortOfReportedTotal || pagingStoppedEarly;
        const complete = (stop === "end" || stop === "total-reached") && !stalled;
        const pagination: CatalogPagination = { items: uniqueCards.length, stalled, complete };
        if (reportedTotalItems !== undefined) pagination.totalItems = reportedTotalItems;
        if (pagination.stalled) pagination.reason = stop;
        if (pagination.stalled) {
          console.warn(
            `[composio] marketplace catalog paging stopped early (${stop}) after ${uniqueCards.length} toolkits`
              + (reportedTotalItems !== undefined ? ` of ~${reportedTotalItems}` : "")
              + "; serving a partial marketplace",
          );
        }
        toolkitCache = { at: Date.now(), cards: uniqueCards, identity: identity!, pagination };
        return { cards: uniqueCards, source: "api", pagination };
      }
    } catch {}
  }
  return { cards: CURATED, source: "curated" };
}

/** The default provider: Composio, managed or a person's own project. */
export const composioProvider: ConnectorProvider = {
  id: "composio",
  mode: connectionModeFor,
  isConfigured: configuredFor,
  inventory: connectedServicesInventory,
  tools: (cfg, force) => listConnectorTools(cfg, { force }),
  serviceSlugs: connectedServiceSlugs,
  status: connectionStatus,
  removeService,
  removeAccount,
  prepareAuthConfigs: prepareConnectionAuthConfigs,
  authorize: authorizeService,
  catalog: listToolkits,
  relayMcp,
};
