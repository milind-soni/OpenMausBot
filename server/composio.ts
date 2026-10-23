// A Composio project key (ak_…) creates or reuses one Session, which owns connection state, auth links and the MCP endpoint.
import { saveConfig, type AppConfig } from "./config.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { managedConnectorUnavailableReason, managedCustomAuthReason } from "../shared/connector-availability.ts";
import {
  DEFAULT_BACKEND_ORIGIN,
  apiBase,
  canonicalToolkitSlug,
  inputError,
  keepAuthConfigPick,
  noAuthConfigReason,
  offForToolRouterReason,
  projectAuthConfigs,
  projectHeaders,
  refusedAuthConfigReason,
  responseError,
  forgetProjectAuthConfigs,
  type AuthConfigMap,
} from "./composio-project.ts";
import { noManagedAuthToolkit, withAuthConfigHint } from "./connector-auth-config-hint.ts";
import { planAccountLink } from "../shared/connector-account-link.ts";
import type { CuratedConnectorSlug } from "../shared/connector-curated.ts";
import { CONNECTOR_TOOL_NAME_PATTERN, type ConnectorToolGrant } from "../shared/wire.ts";
import {
  CONNECTOR_ALLOWED_TOOLS_ENV,
  CONNECTOR_ALLOWED_TOOLS_MAX_BYTES,
  CONNECTOR_SERVICE_SLUGS_ENV,
  CONNECTOR_SERVICE_SLUGS_MAX_BYTES,
  serializeConnectorAllowedTools,
  serializeConnectorServiceSlugs,
} from "./connector-advertisement.ts";
import { serviceSlugFor, serviceSlugForCandidates } from "./connector-verdict.ts";
import { parseMcpResponse, withToolsListFallback } from "./connector-tools-list.ts";
import { brokerAccess, type BrokerAccess } from "./composio-broker-access.ts";
export { applyManagedBrokerMessage, brokerAccess, setManagedBrokerAccess, type BrokerAccess } from "./composio-broker-access.ts";

function toolkitBase() {
  return (process.env.OMB_COMPOSIO_TOOLKITS_API ?? `${DEFAULT_BACKEND_ORIGIN}/api/v3`).replace(/\/$/, "");
}

const sessionResponseSchema = z.object({
  session_id: z.string().min(1),
  mcp: z.object({ type: z.enum(["http", "sse"]), url: z.string().min(1) }),
  config: z.object({
    user_id: z.string().optional(),
    multi_account: z.object({
      enable: z.boolean().optional(),
      max_accounts_per_toolkit: z.number().optional(),
      require_explicit_selection: z.boolean().optional(),
    }).optional(),
    auth_configs: z.record(z.string(), z.string()).optional(),
  }).optional(),
});
type SessionResponse = z.infer<typeof sessionResponseSchema>;

export interface ConnectedAccountSummary {
  id: string;
  alias?: string;
  status: string;
}

export interface ConnectorServiceState {
  connected: boolean;
  pending: boolean;
  status: string;
  accounts: ConnectedAccountSummary[];
}

interface AccountLinkRequest {
  toolkit: string;
  alias?: string;
}

const connectedAccountResponseSchema = z.object({
  id: z.string().optional(),
  alias: z.string().nullable().optional(),
  status: z.string().optional(),
  updated_at: z.string().optional(),
  toolkit: z.object({ slug: z.string().optional() }).optional(),
});
type ConnectedAccountResponse = z.infer<typeof connectedAccountResponseSchema>;

const connectedAccountsPageSchema = z.object({
  items: z.array(connectedAccountResponseSchema),
  next_cursor: z.string().nullable().optional(),
});

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
const connectorServicesResponseSchema = z.object({ services: z.record(z.string(), connectorServiceSchema).optional() });
const removalResponseSchema = z.object({ removed: z.number() });
const authUrlResponseSchema = z.object({ url: z.string().optional() });
const linkResponseSchema = z.object({ redirect_url: z.string().optional() });

const MULTI_ACCOUNT_CONFIG = {
  enable: true,
  max_accounts_per_toolkit: 5,
  require_explicit_selection: true,
} as const;

interface SessionCreateRequest {
  user_id: string;
  manage_connections: { enable: boolean; enable_wait_for_connections: boolean; enable_connection_removal: boolean };
  multi_account: typeof MULTI_ACCOUNT_CONFIG;
  /** Sent only when the project has configs: a Session can't be edited later, and an empty map pins "no custom auth" for its life. */
  auth_configs?: AuthConfigMap;
}
const MAX_CONNECTED_ACCOUNT_PAGES = 100;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const printableAliasSchema = z.string().min(1).max(64).refine((value) => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return false;
  }
  return true;
});

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ComposioMcpIntegration {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface IntegrationContext {
  harnessUrl: string;
  commsToken: string;
  botId: string;
  threadId: string;
  connectorTools?: Record<string, ConnectorToolGrant>;
  /** A Team Cloud member's own installation, instead of this server's. */
  as?: BrokerAccess;
}

/** A user's own project key wins over the managed broker; "" means cleared, so the broker takes over again. */
function projectApiKey(cfg: AppConfig): string | null {
  return cfg.composio?.apiKey?.trim() || null;
}

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

function canonicalServiceRecord<T>(services: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(services).map(([slug, state]) => [canonicalToolkitSlug(slug), state]),
  );
}

function requestedServiceRecord<T>(services: Record<string, T>, requested: string[]): Record<string, T> {
  const canonical = canonicalServiceRecord(services);
  return Object.fromEntries(
    requested.flatMap((slug) => {
      const state = canonical[canonicalToolkitSlug(slug)];
      return state === undefined ? [] : [[slug, state]];
    }),
  );
}

export function connectionMode(cfg: AppConfig): "managed" | "self-hosted" | "unavailable" {
  if (projectApiKey(cfg)) return "self-hosted";
  if (brokerAccess()) return "managed";
  return "unavailable";
}

export function configured(cfg: AppConfig): boolean {
  return connectionMode(cfg) !== "unavailable";
}

/** "unreadable": the desktop shell set OMB_CREDENTIAL_STORE=unavailable, so the UI keeps its list instead of wiping it. */
export type ConnectorAvailability = "configured" | "unconfigured" | "unreadable";

export function connectorAvailability(
  cfg: AppConfig,
  storeState: string | undefined = process.env.OMB_CREDENTIAL_STORE,
): ConnectorAvailability {
  if (configured(cfg)) return "configured";
  return storeState === "unavailable" ? "unreadable" : "unconfigured";
}

/** Only a host the managed service comes with (the desktop app, OMB_DESKTOP_PARENT=1, or a Cloud home) calls a missing one an outage. */
export type ConnectorSetup = "ready" | "needs-setup" | "service-unavailable";

export function connectorSetup(
  cfg: AppConfig,
  managedHost: boolean = process.env.OMB_DESKTOP_PARENT === "1",
): ConnectorSetup {
  if (configured(cfg)) return "ready";
  return managedHost ? "service-unavailable" : "needs-setup";
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

/** Composio's own hosts, or the origin of an explicit OMB_COMPOSIO_API backend; any other host is refused. */
export function trustedSessionMcpUrl(value: string): boolean {
  let mcp: URL;
  try {
    mcp = new URL(value);
  } catch {
    return false;
  }
  if (mcp.protocol === "https:" && (mcp.hostname === "composio.dev" || mcp.hostname.endsWith(".composio.dev"))) return true;
  if (mcp.protocol !== "https:" && !(mcp.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(mcp.hostname))) return false;
  const override = process.env.OMB_COMPOSIO_API;
  if (!override) return false;
  try {
    return new URL(override).origin === mcp.origin;
  } catch {
    return false;
  }
}

function parseSessionResponse(session: SessionResponse): SessionResponse {
  const mcp = new URL(session.mcp.url);
  if (!trustedSessionMcpUrl(session.mcp.url)) {
    throw new Error("Composio returned an untrusted Session MCP URL");
  }
  return { ...session, mcp: { ...session.mcp, url: mcp.toString() } };
}

function supportsMultiAccount(session: SessionResponse): boolean {
  // Only `enable` gates reuse: Composio may clamp or omit the cap and selection flags in its echo, so comparing them
  // would recreate the Session on every request.
  return session.config?.multi_account?.enable === true;
}

/** Sessions this boot already upgraded once: if Composio still doesn't echo multi-account, it isn't granting it. */
const multiAccountUpgradeAttempted = new Set<string>();
/** Likewise for an `auth_configs` echo Composio leaves out. */
const authConfigUpgradeAttempted = new Set<string>();

export function normalizeAccountAlias(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = z.string().safeParse(value);
  if (!parsed.success) throw inputError("Account alias must be text");
  const alias = parsed.data.trim();
  if (!printableAliasSchema.safeParse(alias).success) {
    throw inputError("Account alias must be 1-64 printable characters");
  }
  return alias;
}

function validAccountId(value: string | undefined): value is string {
  return Boolean(value && ACCOUNT_ID.test(value));
}

async function getProjectSession(apiKey: string, sessionId: string): Promise<SessionResponse | null> {
  const res = await fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(sessionId)}`, {
    headers: projectHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await responseError(res, `Composio session: HTTP ${res.status}`));
  return parseSessionResponse(sessionResponseSchema.parse(await res.json()));
}

function sessionCoversAuthConfigs(session: SessionResponse, wanted: AuthConfigMap): boolean {
  const have = session.config?.auth_configs ?? {};
  const haveLower = Object.fromEntries(Object.entries(have).map(([slug, id]) => [canonicalToolkitSlug(slug), id]));
  return Object.entries(wanted).every(([slug, id]) => haveLower[slug] === id);
}

function authConfigsKey(sessionId: string, wanted: AuthConfigMap): string {
  return `${sessionId}:${JSON.stringify(wanted)}`;
}

function authConfigsReady(session: SessionResponse, wanted: AuthConfigMap): boolean {
  return sessionCoversAuthConfigs(session, wanted) || authConfigUpgradeAttempted.has(authConfigsKey(session.session_id, wanted));
}

const REFUSED_SESSION_STATUSES = new Set([400, 404, 409, 422]);

/** An auth config Composio refuses is left out of the new Session (all of them, if its answer names none): no config
 * may block the rest. `named` is what the Session was created with. */
async function createProjectSession(
  apiKey: string,
  userId: string,
  authConfigs: AuthConfigMap,
): Promise<{ sessionId: string; named: AuthConfigMap; refused?: string }> {
  const post = (configs: AuthConfigMap) => {
    const sessionRequest: SessionCreateRequest = {
      user_id: userId,
      manage_connections: { enable: true, enable_wait_for_connections: true, enable_connection_removal: true },
      multi_account: MULTI_ACCOUNT_CONFIG,
    };
    if (Object.keys(configs).length) sessionRequest.auth_configs = configs;
    return fetch(`${apiBase()}/tool_router/session`, {
      method: "POST",
      headers: projectHeaders(apiKey, true),
      body: JSON.stringify(sessionRequest),
      signal: AbortSignal.timeout(30_000),
    });
  };
  let named = authConfigs;
  let res = await post(named);
  let refused: string | undefined;
  while (!res.ok && Object.keys(named).length && REFUSED_SESSION_STATUSES.has(res.status)) {
    const said = await responseError(res, `HTTP ${res.status}`);
    const kept = Object.fromEntries(Object.entries(named).filter(([, id]) => !said.includes(id)));
    named = Object.keys(kept).length < Object.keys(named).length ? kept : {};
    refused = said;
    console.warn(`[composio] Composio refused a Session naming the project's auth configs (${said}); creating it without them`);
    res = await post(named);
  }
  if (!res.ok) throw new Error(await responseError(res, `Composio rejected this key (HTTP ${res.status})`));
  const session = parseSessionResponse(sessionResponseSchema.parse(await res.json()));
  authConfigUpgradeAttempted.add(authConfigsKey(session.session_id, authConfigs));
  return { sessionId: session.session_id, named, ...(refused ? { refused } : {}) };
}

export async function prepareProjectSession(
  apiKey: string,
  current?: { apiKey?: string; userId?: string; sessionId?: string },
  knownAuthConfigs?: AuthConfigMap,
): Promise<{ apiKey: string; userId: string; sessionId: string }> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Enter a Composio project API key");
  if (!trimmed.startsWith("ak_")) throw new Error("Composio project API keys start with ak_");

  // A Session names its auth configs at creation, so the project's are read before deciding to reuse it.
  const authConfigs = knownAuthConfigs ?? (await projectAuthConfigs(trimmed)).configs;
  let priorUserId = current?.userId;
  if (trimmed === current?.apiKey && current.sessionId) {
    const existing = await getProjectSession(trimmed, current.sessionId);
    if (existing && supportsMultiAccount(existing) && authConfigsReady(existing, authConfigs)) {
      return {
        apiKey: trimmed,
        userId: existing.config?.user_id ?? current.userId ?? `openmausbot_${randomUUID()}`,
        sessionId: existing.session_id,
      };
    }
    // Connections belong to the Composio user, not the Session: recreating with the same user id keeps every grant.
    priorUserId = existing?.config?.user_id ?? priorUserId;
  }

  const userId = priorUserId ?? `openmausbot_${randomUUID()}`;
  const { sessionId } = await createProjectSession(trimmed, userId, authConfigs);
  return { apiKey: trimmed, userId, sessionId };
}

async function adoptProjectSession(
  composio: NonNullable<AppConfig["composio"]>,
  apiKey: string,
  userId: string,
  sessionId: string,
): Promise<SessionResponse> {
  multiAccountUpgradeAttempted.add(sessionId);
  composio.userId = userId;
  composio.sessionId = sessionId;
  saveConfig({ composio: { userId, sessionId } });
  const created = await getProjectSession(apiKey, sessionId);
  if (!created) throw new Error("Composio Session disappeared after creation");
  return created;
}

async function ensureProjectSession(cfg: AppConfig): Promise<SessionResponse> {
  const composio = cfg.composio;
  const apiKey = projectApiKey(cfg);
  if (!composio || !apiKey) throw new Error("No Composio project key configured");
  const { configs } = await projectAuthConfigs(apiKey);
  if (composio.sessionId) {
    const existing = await getProjectSession(apiKey, composio.sessionId);
    if (
      existing
      && (supportsMultiAccount(existing) || multiAccountUpgradeAttempted.has(existing.session_id))
      && authConfigsReady(existing, configs)
    ) {
      return existing;
    }
  }
  const prepared = await prepareProjectSession(apiKey, composio, configs);
  return adoptProjectSession(composio, apiKey, prepared.userId, prepared.sessionId);
}

async function recreateProjectSession(cfg: AppConfig, userId: string, authConfigs: AuthConfigMap) {
  const apiKey = projectApiKey(cfg);
  if (!cfg.composio || !apiKey) throw new Error("No Composio project key configured");
  const created = await createProjectSession(apiKey, userId, authConfigs);
  return { ...created, session: await adoptProjectSession(cfg.composio, apiKey, userId, created.sessionId) };
}

/** Composio's wording when a toolkit needs one of the project's own auth configs. */
const NEEDS_AUTH_CONFIG = /does not manage auth|auth[_ ]?config/i;

export async function mcpIntegration(
  cfg: AppConfig,
  context: IntegrationContext,
): Promise<ComposioMcpIntegration | null> {
  if (!configured(cfg)) return null;
  const allowlist = context.connectorTools === undefined
    ? undefined
    : serializeConnectorAllowedTools(context.connectorTools);
  if (allowlist?.oversized) {
    console.warn(
      `[composio] connector allowlist for bot ${context.botId} exceeds ${CONNECTOR_ALLOWED_TOOLS_MAX_BYTES} bytes;`
      + " tools/list stays unfiltered and grants are enforced per call",
    );
  }
  const serviceSlugs = context.connectorTools === undefined
    ? undefined
    : serializeConnectorServiceSlugs(await connectedServiceSlugs(cfg, context.as));
  if (serviceSlugs?.oversized) {
    console.warn(
      `[composio] connector service slugs for bot ${context.botId} exceed ${CONNECTOR_SERVICE_SLUGS_MAX_BYTES} bytes;`
      + " tools/list falls back to plain-prefix resolution",
    );
  }
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.connectors],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      // The bridge gets only this boot's loopback token; project and broker credentials never leave the harness.
      OMB_CONNECTOR_UPSTREAM_URL: `${context.harnessUrl}/api/internal/connectors/mcp`,
      OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: `Bearer ${context.commsToken}` }),
      OMB_HARNESS_URL: context.harnessUrl,
      // A name apart from the agents proxy token: Codex flattens all mounted MCP env into one environment.
      OMB_CONNECTOR_TOKEN: context.commsToken,
      OMB_BOT_ID: context.botId,
      OMB_THREAD_ID: context.threadId,
      ...(allowlist?.env ? { [CONNECTOR_ALLOWED_TOOLS_ENV]: allowlist.env } : {}),
      ...(serviceSlugs?.env ? { [CONNECTOR_SERVICE_SLUGS_ENV]: serviceSlugs.env } : {}),
    },
  };
}

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
  const { bytes, toolkit } = toolCall
    ? withAuthConfigHint(raw, contentType, apiKey ? "self-hosted" : "managed")
    : { bytes: raw, toolkit: null };
  if (toolkit && apiKey) forgetProjectAuthConfigs(apiKey);
  return { status: response.status, bytes, contentType, transportSessionId: nextTransportSessionId };
}

async function listConnectedAccounts(
  apiKey: string,
  userId: string,
  slugs: string[],
): Promise<ConnectedAccountResponse[]> {
  const accounts: ConnectedAccountResponse[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    const params = new URLSearchParams({
      limit: "50",
      user_ids: userId,
      order_by: "updated_at",
      order_direction: "desc",
    });
    if (slugs.length) params.set("toolkit_slugs", slugs.join(","));
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${apiBase()}/connected_accounts?${params}`, {
      headers: projectHeaders(apiKey),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(await responseError(response, `Composio accounts: HTTP ${response.status}`));
    const body = connectedAccountsPageSchema.parse(await response.json());
    accounts.push(...body.items);
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return accounts;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Composio account inventory exceeded the pagination safety limit");
}

async function listSessionToolkits(
  apiKey: string,
  sessionId: string,
): Promise<ToolkitItem[]> {
  const toolkits: ToolkitItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    // Unfiltered, this endpoint pages through the whole marketplace 50 at a time.
    const params = new URLSearchParams({ limit: "50", is_connected: "true" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(
      `${apiBase()}/tool_router/session/${encodeURIComponent(sessionId)}/toolkits?${params}`,
      { headers: projectHeaders(apiKey), signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error(await responseError(response, `Composio toolkits: HTTP ${response.status}`));
    const body = toolkitPageSchema.parse(await response.json());
    toolkits.push(...(body.items ?? []));
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return toolkits;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Composio toolkit inventory exceeded the pagination safety limit");
}

function summarizeAccounts(accounts: ConnectedAccountResponse[], slugs: string[]) {
  const requested = new Set(slugs.map(canonicalToolkitSlug));
  const bySlug = new Map<string, Array<ConnectedAccountSummary & { updatedAt: string }>>();
  for (const account of accounts) {
    const slug = account.toolkit?.slug ? canonicalToolkitSlug(account.toolkit.slug) : "";
    if (!slug || (requested.size && !requested.has(slug)) || !validAccountId(account.id)) continue;
    const alias = account.alias?.trim() ?? "";
    const summary: ConnectedAccountSummary & { updatedAt: string } = {
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

function publicAccount({ id, alias, status }: ConnectedAccountSummary): ConnectedAccountSummary {
  const account: ConnectedAccountSummary = { id, status };
  if (alias) account.alias = alias;
  return account;
}

function serviceStateFromAccounts(
  accounts: ConnectedAccountSummary[],
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
  accountsBySlug: ReadonlyMap<string, ConnectedAccountSummary[]>,
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

export interface ConnectedServicesInventory {
  services: Record<string, ConnectorServiceState>;
  complete: boolean;
}

export async function connectedServicesInventory(cfg: AppConfig, as?: BrokerAccess): Promise<ConnectedServicesInventory> {
  const apiKey = as ? null : projectApiKey(cfg);
  if (!apiKey) {
    const response = await brokerRequest("/v1/connectors/connected", undefined, as);
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    const body = connectorServicesResponseSchema.parse(await response.json());
    const services = canonicalServiceRecord(body.services ?? {});
    return {
      services: Object.fromEntries(
        Object.entries(services).map(([slug, state]) => [slug, {
          connected: state.connected,
          pending: state.pending ?? false,
          status: state.status ?? (state.connected ? "ACTIVE" : "not_connected"),
          accounts: state.accounts ?? [],
        }]),
      ),
      complete: true,
    };
  }
  const session = await ensureProjectSession(cfg);
  const userId = session.config?.user_id ?? cfg.composio?.userId;
  if (!userId) throw new Error("Composio Session returned no user ID");
  const [toolkits, accountResult] = await Promise.all([
    listSessionToolkits(apiKey, session.session_id),
    // Scoped project keys can grant Session reads without the raw connected-account list.
    listConnectedAccounts(apiKey, userId, []).then((accounts) => ({ accounts, complete: true as const }))
      .catch(() => ({ accounts: [] as ConnectedAccountResponse[], complete: false as const })),
  ]);
  return {
    services: allServiceStates(summarizeAccounts(accountResult.accounts, []), toolkits),
    complete: accountResult.complete,
  };
}

export async function connectedServices(cfg: AppConfig, as?: BrokerAccess): Promise<Record<string, ConnectorServiceState>> {
  return (await connectedServicesInventory(cfg, as)).services;
}

/** Rejects a connectorTools patch naming an unconnected service or a tool without its service prefix. Checks that need the
 * network fail open, since call-time enforcement decides. Returns the message or null. */
export async function validateConnectorGrants(
  cfg: AppConfig,
  grants: Record<string, ConnectorToolGrant>,
): Promise<string | null> {
  const connected = await connectedServices(cfg).catch(() => null);
  const candidates = connected ? Object.keys(connected) : [];
  for (const [slug, grant] of Object.entries(grants)) {
    if (grant.tools === "*") continue;
    const misplaced = grant.tools.filter(
      (tool) => (serviceSlugForCandidates(tool, candidates) ?? serviceSlugFor(tool)) !== slug,
    );
    if (misplaced.length) {
      return `connectorTools.${slug}.tools names tools that belong to another service: ${misplaced.join(", ")}`;
    }
  }
  if (!connected) return null;
  const unconnected = Object.keys(grants).filter((slug) => !connected[slug]?.connected);
  if (unconnected.length) {
    return `connectorTools names services that are not connected: ${unconnected.join(", ")}`;
  }
  const catalog = await listToolkits(cfg);
  if (catalog.source !== "api" || !catalog.pagination?.complete) return null;
  const known = new Set(catalog.cards.map((card) => card.slug.toLowerCase()));
  const unknown = Object.keys(grants).filter((slug) => !known.has(slug));
  if (unknown.length) {
    return `connectorTools names services missing from the connected-apps catalog: ${unknown.join(", ")}`;
  }
  return null;
}

export interface ConnectorToolListing {
  name: string;
  description?: string;
}

/** The picker offers exactly what a granted bot's bridge would see. */
export async function listConnectorTools(
  cfg: AppConfig,
  options: { force?: boolean } = {},
): Promise<Record<string, ConnectorToolListing[]>> {
  const identity = connectorToolsIdentity(cfg);
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

const CONNECTOR_TOOLS_CACHE_MS = 60_000;
let connectorToolsCache: { at: number; identity: string; services: Record<string, ConnectorToolListing[]> } | null = null;
/** Cache key per backend, so a config switch never serves the previous backend's tools. */
function connectorToolsIdentity(cfg: AppConfig, as?: BrokerAccess): string {
  const apiKey = as ? null : projectApiKey(cfg);
  if (apiKey) return backendFingerprint("project-tools", apiBase(), apiKey);
  const broker = as ?? brokerAccess();
  return broker ? backendFingerprint("managed-tools", broker.url, broker.token) : "none";
}

let connectorToolsRequest: { identity: string; services: Promise<Record<string, ConnectorToolListing[]>> } | null = null;

/** Real backend slugs, so an underscored service (bland_ai) is never captured by a plain-prefix grant (bland). */
export async function connectedServiceSlugs(cfg: AppConfig, as?: BrokerAccess): Promise<readonly string[]> {
  const identity = connectorToolsIdentity(cfg, as);
  if (connectorServiceSlugsCache?.identity === identity
    && Date.now() - connectorServiceSlugsCache.at < CONNECTOR_SERVICE_SLUGS_CACHE_MS) {
    return connectorServiceSlugsCache.slugs;
  }
  if (connectorServiceSlugsRequest?.identity === identity) return connectorServiceSlugsRequest.slugs;
  const walk = connectedServices(cfg, as).then(
    (services) => {
      const slugs = Object.keys(services);
      connectorServiceSlugsCache = { at: Date.now(), identity, slugs };
      return slugs;
    },
    () => [] as readonly string[],
  );
  connectorServiceSlugsRequest = { identity, slugs: walk };
  try {
    return await walk;
  } finally {
    if (connectorServiceSlugsRequest?.slugs === walk) connectorServiceSlugsRequest = null;
  }
}

const CONNECTOR_SERVICE_SLUGS_CACHE_MS = 60_000;
let connectorServiceSlugsCache: { at: number; identity: string; slugs: readonly string[] } | null = null;
let connectorServiceSlugsRequest: { identity: string; slugs: Promise<readonly string[]> } | null = null;

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
  const connected = await connectedServices(cfg).catch(() => null);
  const candidates = connected ? Object.keys(connected) : [];
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

export async function connectionStatus(cfg: AppConfig, slugs: string[]) {
  const canonicalSlugs = [...new Set(slugs.map(canonicalToolkitSlug))];
  const apiKey = projectApiKey(cfg);
  if (!apiKey) {
    const response = await brokerRequest(`/v1/connectors?${new URLSearchParams({ services: canonicalSlugs.join(",") })}`);
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    const body = connectorServicesResponseSchema.parse(await response.json());
    return requestedServiceRecord(body.services ?? {}, slugs);
  }
  const session = await ensureProjectSession(cfg);
  const params = new URLSearchParams({ limit: "50" });
  if (canonicalSlugs.length) params.set("toolkits", canonicalSlugs.join(","));
  const userId = session.config?.user_id ?? cfg.composio?.userId;
  const [res, accounts] = await Promise.all([
    fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(session.session_id)}/toolkits?${params}`, {
      headers: projectHeaders(apiKey),
      signal: AbortSignal.timeout(15_000),
    }),
    // Session toolkits list an account only once it is usable, so read the account lifecycle too (scoped keys may be denied it).
    userId
      ? listConnectedAccounts(apiKey, userId, canonicalSlugs).catch(() => [])
      : Promise.resolve([]),
  ]);
  if (!res.ok) throw new Error(await responseError(res, `Composio toolkits: HTTP ${res.status}`));
  const body = toolkitPageSchema.parse(await res.json());
  const bySlug = new Map(
    (body.items ?? []).flatMap((item) => item.slug ? [[canonicalToolkitSlug(item.slug), item] as const] : []),
  );
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

export async function removeService(cfg: AppConfig, slug: string, as?: BrokerAccess) {
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
export async function removeAccount(cfg: AppConfig, slug: string, accountId: string) {
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

/** A bot's explicit auth config for a toolkit, checked in the person's own project and kept before any card shows. */
export async function useRequestedAuthConfigs(cfg: AppConfig, items: ReadonlyArray<{ slug: string; authConfigId?: string }>) {
  const apiKey = projectApiKey(cfg);
  for (const { slug, authConfigId } of items) {
    if (!authConfigId) continue;
    const toolkit = canonicalToolkitSlug(slug);
    if (!apiKey) throw inputError(managedCustomAuthReason(toolkit), 409);
    await keepAuthConfigPick(apiKey, toolkit, authConfigId);
  }
}

export async function authorizeService(cfg: AppConfig, slug: string, requestedAlias?: string | null, as?: BrokerAccess) {
  const alias = normalizeAccountAlias(requestedAlias);
  const toolkit = canonicalToolkitSlug(slug);
  const unavailable = managedConnectorUnavailableReason(as ? "managed" : connectionMode(cfg), toolkit);
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
  const session = await ensureProjectSession(cfg);
  const userId = session.config?.user_id ?? cfg.composio?.userId;
  if (!userId) throw new Error("Composio Session has no user ID");
  const accounts = await listConnectedAccounts(apiKey, userId, [toolkit]).catch(() => []);
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
    const project = await projectAuthConfigs(apiKey, { fresh: true });
    if (!project.configs[toolkit]) {
      if (project.readError) throw new Error(`Composio auth configs: ${project.readError}`);
      throw inputError(project.offForToolRouter.includes(toolkit) ? offForToolRouterReason(toolkit) : noAuthConfigReason(toolkit));
    }
    const fresh = await recreateProjectSession(cfg, userId, project.configs);
    if (fresh.refused && !fresh.named[toolkit]) throw inputError(refusedAuthConfigReason(toolkit, fresh.refused));
    res = await link(fresh.session.session_id);
    if (!res.ok) {
      const again = await responseError(res, `Composio authorization: HTTP ${res.status}`);
      throw NEEDS_AUTH_CONFIG.test(again) ? inputError(refusedAuthConfigReason(toolkit, again)) : new Error(again);
    }
  }
  const body = linkResponseSchema.parse(await res.json());
  return { url: trustedAuthUrl(body.redirect_url, toolkit) };
}

export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  /** Toolkits such as public search need no user authorization. */
  noAuth?: boolean;
  domain: string | null;
  categories?: string[];
}

/** Composio lists meta.categories as `{ id, name }` objects (older payloads: plain strings). */
export function toolkitCategories(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names = raw
    .map((entry) => typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined)
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim().slice(0, 40))
    .filter(Boolean);
  const unique = [...new Set(names)].slice(0, 4);
  return unique.length ? unique : undefined;
}

const CURATED: Array<ToolkitCard & { slug: CuratedConnectorSlug }> = [
  { slug: "slack", label: "Slack", blurb: "Post updates and read channels", domain: "slack.com", logo: null, categories: ["Communication"] },
  { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code", domain: "github.com", logo: null, categories: ["Developer tools"] },
  { slug: "gmail", label: "Gmail", blurb: "Read and send email", domain: "gmail.com", logo: null, categories: ["Communication"] },
  { slug: "googlecalendar", label: "Google Calendar", blurb: "Read and create events", domain: "calendar.google.com", logo: null, categories: ["Productivity"] },
  { slug: "googlesheets", label: "Google Sheets", blurb: "Read and update spreadsheets", domain: "sheets.google.com", logo: null, categories: ["Productivity"] },
  { slug: "googledocs", label: "Google Docs", blurb: "Read and write documents", domain: "docs.google.com", logo: null, categories: ["Productivity"] },
  { slug: "googledrive", label: "Google Drive", blurb: "Browse and manage files", domain: "drive.google.com", logo: null, categories: ["Files"] },
  { slug: "notion", label: "Notion", blurb: "Pages and databases", domain: "notion.so", logo: null, categories: ["Productivity"] },
  { slug: "linear", label: "Linear", blurb: "Issues and project tracking", domain: "linear.app", logo: null, categories: ["Developer tools"] },
  { slug: "sentry", label: "Sentry", blurb: "Errors and alerts", domain: "sentry.io", logo: null, categories: ["Developer tools"] },
  { slug: "posthog", label: "PostHog", blurb: "Analytics, feature flags, experiments", domain: "posthog.com", logo: null, categories: ["Analytics"] },
  { slug: "discord", label: "Discord", blurb: "Messages and channels", domain: "discord.com", logo: null, categories: ["Communication"] },
  { slug: "twitter", label: "X (Twitter)", blurb: "Post and read on X", domain: "x.com", logo: null, categories: ["Social"] },
  { slug: "reddit", label: "Reddit", blurb: "Browse and post", domain: "reddit.com", logo: null, categories: ["Social"] },
  { slug: "zapier", label: "Zapier", blurb: "Connect 9,000+ apps", domain: "zapier.com", logo: null, categories: ["Automation"] },
  { slug: "hubspot", label: "HubSpot", blurb: "CRM search & updates", domain: "hubspot.com", logo: null, categories: ["Sales and CRM"] },
  { slug: "salesforce", label: "Salesforce", blurb: "CRM records and reports", domain: "salesforce.com", logo: null, categories: ["Sales and CRM"] },
  { slug: "jira", label: "Jira", blurb: "Issues and sprints", domain: "atlassian.com", logo: null, categories: ["Developer tools"] },
  { slug: "asana", label: "Asana", blurb: "Tasks and projects", domain: "asana.com", logo: null, categories: ["Productivity"] },
  { slug: "trello", label: "Trello", blurb: "Boards and cards", domain: "trello.com", logo: null, categories: ["Productivity"] },
  { slug: "dropbox", label: "Dropbox", blurb: "Files and folders", domain: "dropbox.com", logo: null, categories: ["Files"] },
  { slug: "airtable", label: "Airtable", blurb: "Bases and records", domain: "airtable.com", logo: null, categories: ["Productivity"] },
  { slug: "figma", label: "Figma", blurb: "Files and comments", domain: "figma.com", logo: null, categories: ["Design"] },
  { slug: "stripe", label: "Stripe", blurb: "Payments and customers", domain: "stripe.com", logo: null, categories: ["Finance"] },
];

let toolkitCache: { at: number; cards: ToolkitCard[]; identity: string; pagination: CatalogPagination } | null = null;

export type CatalogStopReason =
  | "end"
  | "total-reached"
  | "page-stuck"
  | "cursor-repeated"
  | "http-error"
  | "bad-page"
  | "limit";

export interface CatalogPagination {
  items: number;
  /** Upstream's own count of the full marketplace, when it reports one. */
  totalItems?: number;
  /** True when paging stopped before the reported total. */
  stalled: boolean;
  reason?: CatalogStopReason;
  /** True only when the walk reached its natural end without stalling. */
  complete: boolean;
}

export async function listToolkits(cfg: AppConfig): Promise<{ cards: ToolkitCard[]; source: "api" | "curated"; pagination?: CatalogPagination }> {
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

export async function toolkitCard(cfg: AppConfig, slug: string): Promise<ToolkitCard> {
  const normalized = canonicalToolkitSlug(slug);
  const { cards } = await listToolkits(cfg);
  return cards.find((card) => card.slug.toLowerCase() === normalized)
    ?? CURATED.find((card) => card.slug === normalized)
    ?? {
      slug: normalized,
      label: normalized.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      blurb: "Connect this app so your bot can continue",
      logo: null,
      domain: null,
    };
}

export const CURATED_SLUGS = CURATED.map((c) => c.slug);
