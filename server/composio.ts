// A project API key (ak_…) creates/reuses one Composio Session. That
// Session owns connection state, auth links and the MCP endpoint.
import { saveConfig, type AppConfig } from "./config.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { managedConnectorUnavailableReason } from "../shared/connector-availability.ts";

const DEFAULT_BACKEND_ORIGIN = "https://backend.composio.dev";

function apiBase() {
  return (process.env.OMB_COMPOSIO_API ?? `${DEFAULT_BACKEND_ORIGIN}/api/v3.1`).replace(/\/$/, "");
}

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
    /** toolkit slug → the project's own auth config the Session uses for it */
    auth_configs: z.record(z.string(), z.string()).optional(),
  }).optional(),
});
type SessionResponse = z.infer<typeof sessionResponseSchema>;

// A project's own auth configs (bring-your-own OAuth app, API-key toolkits
// such as twitter that Composio does not manage). A Session only uses one
// when it was created with the config's id under `auth_configs`.
const authConfigItemSchema = z.object({
  id: z.string().optional(),
  status: z.string().nullable().optional(),
  is_composio_managed: z.boolean().optional(),
  is_enabled_for_tool_router: z.boolean().nullable().optional(),
  last_updated_at: z.string().nullable().optional(),
  toolkit: z.object({ slug: z.string().optional() }).optional(),
});
const authConfigsPageSchema = z.object({
  items: z.array(authConfigItemSchema).optional(),
  next_cursor: z.string().nullable().optional(),
});
/** toolkit slug (lowercase) → auth config id */
type AuthConfigMap = Record<string, string>;
const MAX_AUTH_CONFIG_PAGES = 20;

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
  /** toolkit slug → the project's own auth config id; named only when the
   * project has its own configs, since a Session cannot be edited afterwards
   * and an empty map would pin "no custom auth" for the Session's lifetime */
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
}

let managedBrokerAccess: { url: string; token: string } | null | undefined;

const managedBrokerMessageSchema = z.record(z.string(), z.unknown());
const managedBrokerToken = /^[0-9a-f]{64}$/;

function normalizeManagedBrokerUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The connected-apps service URL must not include credentials, a query, or a fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The connected-apps service must use HTTPS");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function applyManagedBrokerMessage(message: unknown): boolean {
  const parsed = managedBrokerMessageSchema.safeParse(message);
  if (
    !parsed.success ||
    parsed.data.type !== "openmausbot:managed-composio" ||
    !Object.hasOwn(parsed.data, "access")
  ) {
    return false;
  }
  setManagedBrokerAccess(parsed.data.access);
  return true;
}

export function setManagedBrokerAccess(access: unknown): void {
  if (access === null) {
    managedBrokerAccess = null;
    return;
  }
  const parsed = z.object({ url: z.string().url(), token: z.string().regex(managedBrokerToken) }).strict().parse(access);
  managedBrokerAccess = { url: normalizeManagedBrokerUrl(parsed.url), token: parsed.token };
}

function brokerAccess(): { url: string; token: string } | null {
  if (managedBrokerAccess !== undefined) return managedBrokerAccess;
  const url = process.env.OMB_COMPOSIO_BROKER_URL?.trim();
  const token = process.env.OMB_COMPOSIO_BROKER_TOKEN?.trim();
  if (!url || !token) return null;
  if (!managedBrokerToken.test(token)) throw new Error("The connected-apps service token is invalid");
  return { url: normalizeManagedBrokerUrl(url), token };
}

/** A user-owned project is an explicit choice and must win over the packaged
 * app's managed broker. An empty key means that choice was cleared, so the
 * managed service may take over again without a restart. */
function projectApiKey(cfg: AppConfig): string | null {
  const apiKey = cfg.composio?.apiKey?.trim();
  return apiKey || null;
}

/** Composio's toolkit slug is `twitter`. Keep accepting the old `x` alias at
 * every local boundary so saved connector cards and model calls keep working. */
function canonicalToolkitSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  return normalized === "x" ? "twitter" : normalized;
}

/** Keep credential-backed caches and transport sessions separated without
 * retaining another plaintext copy of the credential as their identity. */
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

/** Preserve the caller's key (`x` included) while speaking canonical toolkit
 * slugs upstream. Old connector cards index status with their saved slug. */
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

/** Three answers, not two. The desktop shell sets OMB_CREDENTIAL_STORE to
 * "unavailable" when it could not read credentials.bin this launch; without
 * that signal an unreadable store is indistinguishable from a user who never
 * connected anything, and the UI wipes a list it should have kept. */
export type ConnectorAvailability = "configured" | "unconfigured" | "unreadable";

export function connectorAvailability(
  cfg: AppConfig,
  storeState: string | undefined = process.env.OMB_CREDENTIAL_STORE,
): ConnectorAvailability {
  if (configured(cfg)) return "configured";
  return storeState === "unavailable" ? "unreadable" : "unconfigured";
}

async function brokerRequest(path: string, init?: RequestInit): Promise<Response> {
  const broker = brokerAccess();
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

function projectHeaders(apiKey: string, json = false) {
  const headers = new Headers({ "x-api-key": apiKey });
  if (json) headers.set("content-type", "application/json");
  return headers;
}

async function responseError(res: Response, fallback: string) {
  const raw = await res.text().catch(() => "");
  try {
    const body = JSON.parse(raw);
    return String(body?.message ?? body?.error?.message ?? body?.error ?? fallback);
  } catch {
    return raw.trim().slice(0, 300) || fallback;
  }
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

function parseSessionResponse(session: SessionResponse): SessionResponse {
  const mcp = new URL(session.mcp.url);
  if (mcp.protocol !== "https:" || (mcp.hostname !== "composio.dev" && !mcp.hostname.endsWith(".composio.dev"))) {
    throw new Error("Composio returned an untrusted Session MCP URL");
  }
  return { ...session, mcp: { ...session.mcp, url: mcp.toString() } };
}

function supportsMultiAccount(session: SessionResponse): boolean {
  // Only `enable` gates reuse. The cap and selection flags are what we ASK
  // for at creation; if Composio clamps or omits them in the echo, recreating
  // the Session would post the same config and get the same echo back — a
  // strict equality check here can only manufacture a recreate-per-request
  // loop, never fix anything.
  return session.config?.multi_account?.enable === true;
}

/** Session ids this boot already tried to upgrade once. If the fresh Session
 *  STILL doesn't echo multi-account, Composio isn't granting it — run with
 *  what we have (single-account behavior) instead of recreating a Session and
 *  rewriting config.json on every request. */
const multiAccountUpgradeAttempted = new Set<string>();
/** Session id + auth-config map pairs this boot already created a Session
 *  for. Same idea: if Composio does not echo `auth_configs`, recreating the
 *  Session on every check would loop without changing anything. */
const authConfigUpgradeAttempted = new Set<string>();

function inputError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

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

/** The project's own (non-Composio-managed) auth configs, one per toolkit.
 *  Disabled configs and ones switched off for Sessions are skipped; when a
 *  toolkit has several, the most recently updated wins. Ordinary Session
 *  preparation treats a denied list as "none"; an explicit auth retry surfaces
 *  the denial so it cannot replace a usable Session with an incomplete one. */
export async function listCustomAuthConfigs(apiKey: string): Promise<AuthConfigMap> {
  const chosen = new Map<string, { id: string; updated: string }>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_AUTH_CONFIG_PAGES; page++) {
    const params = new URLSearchParams({ is_composio_managed: "false", limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${apiBase()}/auth_configs?${params}`, {
      headers: projectHeaders(apiKey),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(await responseError(res, `Composio auth configs: HTTP ${res.status}`));
    const body = authConfigsPageSchema.parse(await res.json());
    for (const item of body.items ?? []) {
      const slug = item.toolkit?.slug ? canonicalToolkitSlug(item.toolkit.slug) : "";
      if (!slug || !item.id || item.is_composio_managed === true) continue;
      if (item.is_enabled_for_tool_router === false) continue;
      if (item.status && /^(disabled|inactive|expired|deleted)$/i.test(item.status)) continue;
      const updated = item.last_updated_at ?? "";
      const current = chosen.get(slug);
      if (!current || updated > current.updated) chosen.set(slug, { id: item.id, updated });
    }
    const next = body.next_cursor ?? undefined;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return Object.fromEntries([...chosen].sort(([a], [b]) => a.localeCompare(b)).map(([slug, { id }]) => [slug, id]));
}

/** True when the Session already routes every wanted toolkit through the
 *  project's own auth config. Extra configs on the Session are fine; a
 *  missing or different one means the Session predates the config. */
function sessionCoversAuthConfigs(session: SessionResponse, wanted: AuthConfigMap): boolean {
  const have = session.config?.auth_configs ?? {};
  const haveLower = Object.fromEntries(Object.entries(have).map(([slug, id]) => [canonicalToolkitSlug(slug), id]));
  return Object.entries(wanted).every(([slug, id]) => haveLower[slug] === id);
}

function authConfigsKey(sessionId: string, wanted: AuthConfigMap): string {
  return `${sessionId}:${JSON.stringify(wanted)}`;
}

/** Validate a project key and return one reusable Session for this install. */
export async function prepareProjectSession(
  apiKey: string,
  current?: { apiKey?: string; userId?: string; sessionId?: string },
  knownAuthConfigs?: AuthConfigMap,
): Promise<{ apiKey: string; userId: string; sessionId: string }> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Enter a Composio project API key");
  if (!trimmed.startsWith("ak_")) throw new Error("Composio project API keys start with ak_");

  // The project's own auth configs must be named at creation — a Session
  // cannot be edited later — so they are read before deciding whether the
  // current Session is still the right one (issue #509: a twitter auth
  // config created after the Session existed was never used).
  const authConfigs = knownAuthConfigs
    ?? await listCustomAuthConfigs(trimmed).catch((): AuthConfigMap => ({}));
  let priorUserId = current?.userId;
  if (trimmed === current?.apiKey && current.sessionId) {
    const existing = await getProjectSession(trimmed, current.sessionId);
    if (
      existing
      && supportsMultiAccount(existing)
      && (sessionCoversAuthConfigs(existing, authConfigs)
        || authConfigUpgradeAttempted.has(authConfigsKey(existing.session_id, authConfigs)))
    ) {
      return {
        apiKey: trimmed,
        userId: existing.config?.user_id ?? current.userId ?? `openmausbot_${randomUUID()}`,
        sessionId: existing.session_id,
      };
    }
    // Connections belong to the Composio user, not the Session. Recreate old
    // single-account Sessions with the same user ID so every existing grant is
    // retained while the new Session opts into explicit multi-account routing.
    priorUserId = existing?.config?.user_id ?? priorUserId;
  }

  const userId = priorUserId ?? `openmausbot_${randomUUID()}`;
  const sessionRequest: SessionCreateRequest = {
    user_id: userId,
    manage_connections: {
      enable: true,
      enable_wait_for_connections: true,
      enable_connection_removal: true,
    },
    multi_account: MULTI_ACCOUNT_CONFIG,
  };
  if (Object.keys(authConfigs).length) sessionRequest.auth_configs = authConfigs;
  const res = await fetch(`${apiBase()}/tool_router/session`, {
    method: "POST",
    headers: projectHeaders(trimmed, true),
    body: JSON.stringify(sessionRequest),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(await responseError(res, `Composio rejected this key (HTTP ${res.status})`));
  const session = parseSessionResponse(sessionResponseSchema.parse(await res.json()));
  // If Composio does not echo the configs back, a later check would ask for
  // the same creation again — remember this attempt so it happens once.
  authConfigUpgradeAttempted.add(authConfigsKey(session.session_id, authConfigs));
  return { apiKey: trimmed, userId, sessionId: session.session_id };
}

async function ensureProjectSession(cfg: AppConfig): Promise<SessionResponse> {
  const composio = cfg.composio;
  const apiKey = projectApiKey(cfg);
  if (!composio || !apiKey) throw new Error("No Composio project key configured");
  if (composio.sessionId) {
    const existing = await getProjectSession(apiKey, composio.sessionId);
    if (existing && (supportsMultiAccount(existing) || multiAccountUpgradeAttempted.has(existing.session_id))) {
      return existing;
    }
  }
  // A missing/deleted session is recreated and its non-secret identifiers are
  // persisted so an edited config/env setup does not recreate it every launch.
  const prepared = await prepareProjectSession(apiKey, composio);
  multiAccountUpgradeAttempted.add(prepared.sessionId);
  composio.userId = prepared.userId;
  composio.sessionId = prepared.sessionId;
  saveConfig({ composio: { userId: prepared.userId, sessionId: prepared.sessionId } });
  const created = await getProjectSession(apiKey, prepared.sessionId);
  if (!created) throw new Error("Composio Session disappeared after creation");
  return created;
}

/** Replace the current Session with a freshly created one — the only way to
 *  pick up an auth config the user added after the Session was made. The
 *  Composio user id is kept, so every existing connection survives. */
async function recreateProjectSession(
  cfg: AppConfig,
  userId: string,
  authConfigs: AuthConfigMap,
): Promise<SessionResponse> {
  const composio = cfg.composio;
  const apiKey = projectApiKey(cfg);
  if (!composio || !apiKey) throw new Error("No Composio project key configured");
  const prepared = await prepareProjectSession(
    apiKey,
    { apiKey, userId },
    authConfigs,
  );
  multiAccountUpgradeAttempted.add(prepared.sessionId);
  composio.userId = prepared.userId;
  composio.sessionId = prepared.sessionId;
  saveConfig({ composio: { userId: prepared.userId, sessionId: prepared.sessionId } });
  const created = await getProjectSession(apiKey, prepared.sessionId);
  if (!created) throw new Error("Composio Session disappeared after creation");
  return created;
}

/** Composio's wording when a toolkit has no managed auth and the Session was
 *  not told which of the project's own auth configs to use. */
const NEEDS_AUTH_CONFIG = /does not manage auth|auth[_ ]?config/i;

export async function mcpIntegration(
  cfg: AppConfig,
  context: IntegrationContext,
): Promise<ComposioMcpIntegration | null> {
  if (!configured(cfg)) return null;
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.connectors],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      // The provider-facing bridge receives only this boot's loopback token.
      // Project/broker credentials stay in the harness process, so a coding
      // agent that prints its environment cannot export a durable secret.
      OMB_CONNECTOR_UPSTREAM_URL: `${context.harnessUrl}/api/internal/connectors/mcp`,
      OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: `Bearer ${context.commsToken}` }),
      OMB_HARNESS_URL: context.harnessUrl,
      // Distinct from the agents proxy token: Codex flattens mounted MCP env
      // variables into one process environment, so a shared name would let
      // the later agents mount overwrite this connector-scoped capability.
      OMB_CONNECTOR_TOKEN: context.commsToken,
      OMB_BOT_ID: context.botId,
      OMB_THREAD_ID: context.threadId,
    },
  };
}

export async function relayMcp(
  cfg: AppConfig,
  payload: JsonValue,
  transportSessionId?: string,
): Promise<{ status: number; bytes: Uint8Array; contentType: string; transportSessionId?: string }> {
  const apiKey = projectApiKey(cfg);
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
    const broker = brokerAccess();
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
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  if (forwardedTransportSessionId) rememberTransportSession(forwardedTransportSessionId, identity);
  const nextTransportSessionId = response.headers.get("mcp-session-id") ?? undefined;
  if (nextTransportSessionId) rememberTransportSession(nextTransportSessionId, identity);
  return {
    status: response.status,
    bytes,
    contentType: response.headers.get("content-type") ?? "application/json",
    transportSessionId: nextTransportSessionId,
  };
}

async function listConnectedAccounts(
  apiKey: string,
  userId: string,
  slugs: string[],
): Promise<ConnectedAccountResponse[]> {
  const accounts: ConnectedAccountResponse[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  // Five accounts per toolkit can exceed one provider page when a user has
  // many apps. Follow Composio's cursor instead of silently dropping entries.
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
    // The unfiltered endpoint contains the entire Composio marketplace and is
    // cursor-paginated in 50-item pages. The Connected tab only needs the
    // user's connected toolkits, so avoid scanning hundreds of unrelated apps.
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

/**
 * Enumerate the user's complete connected-account inventory without depending
 * on marketplace ordering or catalog pagination.
 */
export async function connectedServices(cfg: AppConfig): Promise<Record<string, ConnectorServiceState>> {
  const apiKey = projectApiKey(cfg);
  if (!apiKey) {
    const response = await brokerRequest("/v1/connectors/connected");
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    const body = connectorServicesResponseSchema.parse(await response.json());
    const services = canonicalServiceRecord(body.services ?? {});
    return Object.fromEntries(
      Object.entries(services).map(([slug, state]) => [slug, {
        connected: state.connected,
        pending: state.pending ?? false,
        status: state.status ?? (state.connected ? "ACTIVE" : "not_connected"),
        accounts: state.accounts ?? [],
      }]),
    );
  }
  const session = await ensureProjectSession(cfg);
  const userId = session.config?.user_id ?? cfg.composio?.userId;
  if (!userId) throw new Error("Composio Session returned no user ID");
  const [toolkits, accounts] = await Promise.all([
    listSessionToolkits(apiKey, session.session_id),
    // Scoped project keys can grant Session reads without granting the raw
    // connected-account list. The Session still proves which selected/no-auth
    // toolkits belong to this installation, so retain that safe fallback.
    listConnectedAccounts(apiKey, userId, []).catch(() => []),
  ]);
  return allServiceStates(summarizeAccounts(accounts, []), toolkits);
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
    // Session toolkits only include an account once it is usable. Read the
    // account lifecycle too so the UI can distinguish an OAuth flow that is
    // still waiting in the browser from one that expired or failed. Scoped
    // keys may omit connected-account read permission, so this is additive:
    // the normal session result remains the fallback.
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
      // Mirror allServiceStates: a scoped key can be denied the raw account
      // list while the Session still names its selected account. Synthesize
      // that account here too, so a status poll never wipes the row the
      // inventory paths render (merge replaces a slug's state wholesale).
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

/** Backward-compatible service disconnect: removes the Session-selected account. */
export async function removeService(cfg: AppConfig, slug: string) {
  const toolkit = canonicalToolkitSlug(slug);
  const apiKey = projectApiKey(cfg);
  if (!apiKey) {
    const response = await brokerRequest(`/v1/connectors/${encodeURIComponent(toolkit)}`, { method: "DELETE" });
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
  const removed = await fetch(
    `${apiBase()}/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`,
    { method: "DELETE", headers: projectHeaders(apiKey), signal: AbortSignal.timeout(30_000) },
  );
  if (!removed.ok) throw new Error(await responseError(removed, `Composio disconnect: HTTP ${removed.status}`));
  return { removed: 1 };
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
  const removed = await fetch(
    `${apiBase()}/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`,
    { method: "DELETE", headers: projectHeaders(apiKey), signal: AbortSignal.timeout(30_000) },
  );
  if (!removed.ok) throw new Error(await responseError(removed, `Composio disconnect: HTTP ${removed.status}`));
  return { removed: 1 };
}

/** Mint a browser auth link for one service. Returns { url } or throws. */
export async function authorizeService(cfg: AppConfig, slug: string, requestedAlias?: string | null) {
  const alias = normalizeAccountAlias(requestedAlias);
  const toolkit = canonicalToolkitSlug(slug);
  const mode = connectionMode(cfg);
  const unavailable = managedConnectorUnavailableReason(mode, toolkit);
  if (unavailable) throw inputError(unavailable, 409);
  const apiKey = projectApiKey(cfg);
  if (!apiKey) {
    const request: RequestInit = { method: "POST" };
    if (alias) request.body = JSON.stringify({ alias });
    const response = await brokerRequest(`/v1/connectors/${encodeURIComponent(toolkit)}/authorize`, request);
    if (!response.ok) await throwBrokerError(response, `Connected apps: HTTP ${response.status}`);
    const body = authUrlResponseSchema.parse(await response.json());
    return { url: trustedAuthUrl(body.url, toolkit) };
  }
  const session = await ensureProjectSession(cfg);
  const userId = session.config?.user_id ?? cfg.composio?.userId;
  if (!userId) throw new Error("Composio Session has no user ID");
  // A scoped key may be denied account listing — authorization must still
  // work (it always did pre-multi-account), so the alias guardrails degrade
  // to first-account behavior, the same fallback every inventory path takes.
  const accounts = await listConnectedAccounts(apiKey, userId, [toolkit]).catch(() => []);
  const serviceAccounts = accounts.filter((account) =>
    account.toolkit?.slug !== undefined && canonicalToolkitSlug(account.toolkit.slug) === toolkit
  );
  const usableAccounts = serviceAccounts.filter((account) => /^(active|initiated|initializing|pending)$/i.test(account.status ?? ""));
  if (usableAccounts.length >= MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit) {
    throw inputError(`${toolkit} already has the maximum of ${MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit} accounts`, 409);
  }
  if (usableAccounts.length > 0 && !alias) {
    throw inputError("Add an account alias so the existing connection is not replaced");
  }
  if (alias && serviceAccounts.some((account) => account.alias?.trim().toLowerCase() === alias.toLowerCase())) {
    throw inputError(`Account alias "${alias}" is already in use for ${toolkit}`, 409);
  }
  const linkRequest: AccountLinkRequest = { toolkit };
  if (alias) linkRequest.alias = alias;
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
    // The toolkit needs one of the project's own auth configs. The Session
    // names those only at creation, so an auth config the user created after
    // the Session existed is invisible to it: rebuild the Session once and
    // retry. If the project has no config for this toolkit, say what to do
    // instead of echoing Composio's "auth_config_override" hint.
    const authConfigs = await listCustomAuthConfigs(apiKey);
    const covered = Object.keys(authConfigs).some((key) => canonicalToolkitSlug(key) === toolkit);
    if (!covered) {
      throw inputError(
        `${toolkit} has no Composio-managed sign-in. In your Composio project, create an auth config for "${toolkit}" `
          + "(Auth Configs → Create) with your own app credentials, then click Connect again.",
      );
    }
    const fresh = await recreateProjectSession(cfg, userId, authConfigs);
    res = await link(fresh.session_id);
    if (!res.ok) throw new Error(await responseError(res, `Composio authorization: HTTP ${res.status}`));
  }
  const body = linkResponseSchema.parse(await res.json());
  return { url: trustedAuthUrl(body.redirect_url, toolkit) };
}

// ── marketplace catalog ────────────────────────────────────────────────
export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  /** Toolkits such as public search need no user authorization. */
  noAuth?: boolean;
  /** used for the client-side favicon fallback when logo is null/broken */
  domain: string | null;
}

// Curated fallback — the services agentcal's connectors page ships plus the
// long marketplace tail. Logos resolve client-side:
// logo → favicon(domain) → monogram.
const CURATED: ToolkitCard[] = [
  { slug: "slack", label: "Slack", blurb: "Post updates and read channels", domain: "slack.com", logo: null },
  { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code", domain: "github.com", logo: null },
  { slug: "gmail", label: "Gmail", blurb: "Read and send email", domain: "gmail.com", logo: null },
  { slug: "googlecalendar", label: "Google Calendar", blurb: "Read and create events", domain: "calendar.google.com", logo: null },
  { slug: "googlesheets", label: "Google Sheets", blurb: "Read and update spreadsheets", domain: "sheets.google.com", logo: null },
  { slug: "googledocs", label: "Google Docs", blurb: "Read and write documents", domain: "docs.google.com", logo: null },
  { slug: "googledrive", label: "Google Drive", blurb: "Browse and manage files", domain: "drive.google.com", logo: null },
  { slug: "notion", label: "Notion", blurb: "Pages and databases", domain: "notion.so", logo: null },
  { slug: "linear", label: "Linear", blurb: "Issues and project tracking", domain: "linear.app", logo: null },
  { slug: "sentry", label: "Sentry", blurb: "Errors and alerts", domain: "sentry.io", logo: null },
  { slug: "posthog", label: "PostHog", blurb: "Analytics, feature flags, experiments", domain: "posthog.com", logo: null },
  { slug: "discord", label: "Discord", blurb: "Messages and channels", domain: "discord.com", logo: null },
  { slug: "twitter", label: "X (Twitter)", blurb: "Post and read on X", domain: "x.com", logo: null },
  { slug: "reddit", label: "Reddit", blurb: "Browse and post", domain: "reddit.com", logo: null },
  { slug: "zapier", label: "Zapier", blurb: "Connect 9,000+ apps", domain: "zapier.com", logo: null },
  { slug: "hubspot", label: "HubSpot", blurb: "CRM search & updates", domain: "hubspot.com", logo: null },
  { slug: "salesforce", label: "Salesforce", blurb: "CRM records and reports", domain: "salesforce.com", logo: null },
  { slug: "jira", label: "Jira", blurb: "Issues and sprints", domain: "atlassian.com", logo: null },
  { slug: "asana", label: "Asana", blurb: "Tasks and projects", domain: "asana.com", logo: null },
  { slug: "trello", label: "Trello", blurb: "Boards and cards", domain: "trello.com", logo: null },
  { slug: "dropbox", label: "Dropbox", blurb: "Files and folders", domain: "dropbox.com", logo: null },
  { slug: "airtable", label: "Airtable", blurb: "Bases and records", domain: "airtable.com", logo: null },
  { slug: "figma", label: "Figma", blurb: "Files and comments", domain: "figma.com", logo: null },
  { slug: "stripe", label: "Stripe", blurb: "Payments and customers", domain: "stripe.com", logo: null },
];

let toolkitCache: { at: number; cards: ToolkitCard[]; identity: string } | null = null;

/**
 * Marketplace catalog. Tries the v3 toolkits API (official names,
 * descriptions, logos — cached 10 min); falls back to the curated list.
 */
export async function listToolkits(cfg: AppConfig): Promise<{ cards: ToolkitCard[]; source: "api" | "curated" }> {
  const backendKey = projectApiKey(cfg);
  const broker = backendKey ? null : brokerAccess();
  const identity = backendKey
    ? backendFingerprint("project-catalog", toolkitBase(), backendKey)
    : broker
      ? backendFingerprint("managed-catalog", broker.url, broker.token)
      : null;
  if (identity && toolkitCache?.identity === identity && Date.now() - toolkitCache.at < 10 * 60_000) {
    return { cards: toolkitCache.cards, source: "api" };
  }
  if (backendKey || broker) {
    try {
      // The marketplace runs to well over a thousand toolkits and the endpoint
      // is cursor-paginated, so one page stops partway through the alphabet.
      // Follow next_cursor, and keep the pages already collected if a later
      // one fails — a partial catalog still beats the curated two dozen.
      const items: any[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
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
        if (!res.ok) break;
        const json: any = await res.json();
        const pageItems = json.items ?? json.data ?? [];
        if (!Array.isArray(pageItems)) break;
        items.push(...pageItems);
        const next = typeof json.next_cursor === "string" ? json.next_cursor.trim() : "";
        if (!next || seenCursors.has(next)) break;
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
        }));
        const uniqueCards = cards.filter(
          (card, index) => card.slug && cards.findIndex((candidate) => candidate.slug === card.slug) === index,
        );
        toolkitCache = { at: Date.now(), cards: uniqueCards, identity: identity! };
        return { cards: uniqueCards, source: "api" };
      }
    } catch {
      /* fall through to curated */
    }
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
