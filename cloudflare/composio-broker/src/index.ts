import { z } from "zod";

import { planAccountLink } from "../../../shared/connector-account-link";
import { appEventStats, composioWebhook, pollEvents, presentCloudGrant, queueTestEvent, runHourly } from "./app-events";
import {
  ACCOUNT_ID,
  MAX_CONNECTED_ACCOUNT_PAGES,
  actingUser,
  composioRequest,
  json,
  JSON_HEADERS,
  listConnectedAccounts,
  readBoundedBody,
  sha256,
  upstreamError,
  type ConnectedAccountResponse,
  eventInstallation,
  type InstallationRow,
} from "./common";
import { adoptSharedUser, me, shareUser } from "./sharing";
import { createTrigger, deleteTrigger, getTriggerType, listTriggers, listTriggerTypes, updateTrigger } from "./triggers";

interface ComposioSession {
  sessionId: string;
  url: string;
  headers: Record<string, string>;
  userId?: string;
  multiAccountConfigured: boolean;
  /** Project auth configs the Session was created with, by canonical toolkit slug. */
  authConfigs: AuthConfigMap;
}

/** Toolkit slug -> auth config id. */
type AuthConfigMap = Record<string, string>;

interface ConnectedAccountSummary {
  id: string;
  alias?: string;
  status: string;
}

interface ConnectorServiceState {
  connected: boolean;
  pending: boolean;
  status: string;
  accounts: ConnectedAccountSummary[];
}

interface AccountLinkRequest {
  toolkit: string;
  alias?: string;
}

const sessionWireSchema = z.object({
  session_id: z.string().min(1),
  mcp: z.object({
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
  }),
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
type SessionWire = z.infer<typeof sessionWireSchema>;

// A Session reaches a toolkit Composio doesn't manage auth for (HighLevel, a
// BYO OAuth app) only if created with the project's auth config id under
// `auth_configs`.
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
const linkResponseSchema = z.object({ redirect_url: z.string().optional() });
const aliasRequestSchema = z.object({ alias: z.string().nullable().optional() });
const MAX_MCP_BODY = 2 * 1024 * 1024;
const MULTI_ACCOUNT_CONFIG = {
  enable: true,
  max_accounts_per_toolkit: 5,
  require_explicit_selection: true,
} as const;
const MAX_AUTH_CONFIG_PAGES = 20;
/** Composio's catalog cursor is base64 of the page and limit. */
const CATALOG_CURSOR = /^[A-Za-z0-9+/_=-]{1,256}$/;
const printableAliasSchema = z.string().min(1).max(64).refine((value) => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return false;
  }
  return true;
});

function normalizeAccountAlias(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = z.string().safeParse(value);
  if (!parsed.success) throw new Error("Account alias must be text");
  const alias = parsed.data.trim();
  if (!printableAliasSchema.safeParse(alias).success) {
    throw new Error("Account alias must be 1-64 printable characters");
  }
  return alias;
}

/** Composio's slug is `twitter`; saved cards and model calls may still say `x`. */
function canonicalToolkitSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  return normalized === "x" ? "twitter" : normalized;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseSession(value: SessionWire): ComposioSession {
  const url = new URL(value.mcp.url);
  if (url.protocol !== "https:" || (url.hostname !== "composio.dev" && !url.hostname.endsWith(".composio.dev"))) {
    throw new Error("Composio returned an untrusted MCP URL");
  }
  const headers: Record<string, string> = {};
  if (value.mcp.headers) {
    for (const [name, header] of Object.entries(value.mcp.headers)) {
      if (/^(host|cookie|content-length)$/i.test(name)) continue;
      headers[name] = header;
    }
  }
  const config = value.config;
  const multi = config?.multi_account;
  return {
    sessionId: value.session_id,
    url: url.toString(),
    headers,
    userId: config?.user_id,
    // Only `enable` gates reuse: the cap and selection flags are requested at
    // creation, and recreating a Session would post the same config and get
    // the same echo back — strict equality here can only churn, never fix.
    multiAccountConfigured: multi?.enable === true,
    authConfigs: Object.fromEntries(
      Object.entries(config?.auth_configs ?? {}).map(([slug, id]) => [canonicalToolkitSlug(slug), id]),
    ),
  };
}

async function getSession(env: Env, sessionId: string) {
  const response = await composioRequest(env, `/tool_router/session/${encodeURIComponent(sessionId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await upstreamError(response, `Session lookup failed (${response.status})`));
  return parseSession(sessionWireSchema.parse(await response.json()));
}

async function createSession(env: Env, userId: string, authConfigs: AuthConfigMap = {}) {
  const response = await composioRequest(env, "/tool_router/session", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      manage_connections: {
        enable: true,
        enable_wait_for_connections: true,
        enable_connection_removal: true,
      },
      multi_account: MULTI_ACCOUNT_CONFIG,
      ...(Object.keys(authConfigs).length ? { auth_configs: authConfigs } : {}),
    }),
  });
  if (!response.ok) throw new Error(await upstreamError(response, `Session creation failed (${response.status})`));
  const session = parseSession(sessionWireSchema.parse(await response.json()));
  if (session.userId && session.userId !== userId) throw new Error("Composio created a Session for another user");
  return { ...session, userId };
}

/** The project's own (not Composio-managed) auth configs: newest enabled one
 *  per toolkit. Paged like the account inventory. */
async function listCustomAuthConfigs(env: Env): Promise<AuthConfigMap> {
  const chosen = new Map<string, { id: string; updated: string }>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_AUTH_CONFIG_PAGES; page += 1) {
    const params = new URLSearchParams({ is_composio_managed: "false", limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const response = await composioRequest(env, `/auth_configs?${params}`);
    if (!response.ok) throw new Error(await upstreamError(response, `Auth config lookup failed (${response.status})`));
    const body = authConfigsPageSchema.parse(await response.json());
    for (const item of body.items ?? []) {
      const slug = item.toolkit?.slug ? canonicalToolkitSlug(item.toolkit.slug) : "";
      if (!slug || !item.id || item.is_composio_managed === true) continue;
      if (item.is_enabled_for_tool_router === false) continue;
      if (item.status && /^(disabled|inactive|expired|deleted)$/i.test(item.status)) continue;
      const updated = item.last_updated_at ?? "";
      const current = chosen.get(slug);
      if (!current || updated > current.updated) chosen.set(slug, { id: item.id, updated });
    }
    const next = body.next_cursor || undefined;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return Object.fromEntries([...chosen].sort(([a], [b]) => a.localeCompare(b)).map(([slug, { id }]) => [slug, id]));
}

/** The Worker serves one Composio project, so its auth configs are read once
 *  per isolate every ten minutes. A failed read keeps the last good map (or
 *  none) and retries sooner: Sessions must keep working without it. */
const AUTH_CONFIG_TTL_MS = 10 * 60_000;
const AUTH_CONFIG_RETRY_MS = 60_000;
let authConfigCache: { configs: AuthConfigMap; expiresAt: number } | undefined;

async function projectAuthConfigs(env: Env): Promise<AuthConfigMap> {
  if (authConfigCache && Date.now() < authConfigCache.expiresAt) return authConfigCache.configs;
  try {
    authConfigCache = { configs: await listCustomAuthConfigs(env), expiresAt: Date.now() + AUTH_CONFIG_TTL_MS };
  } catch (error) {
    console.error(JSON.stringify({ message: "auth config lookup failed", error: error instanceof Error ? error.message : String(error) }));
    authConfigCache = { configs: authConfigCache?.configs ?? {}, expiresAt: Date.now() + AUTH_CONFIG_RETRY_MS };
  }
  return authConfigCache.configs;
}

function sessionCoversAuthConfigs(session: ComposioSession, wanted: AuthConfigMap) {
  return Object.entries(wanted).every(([slug, id]) => session.authConfigs[slug] === id);
}

function authConfigsKey(sessionId: string, wanted: AuthConfigMap) {
  return `${sessionId}:${JSON.stringify(wanted)}`;
}

/** Session ids this isolate already tried to upgrade once. If the fresh Session
 *  still doesn't echo multi-account, Composio isn't granting it. */
const multiAccountUpgradeAttempted = new Set<string>();
/** Likewise for an `auth_configs` echo Composio leaves out, keyed by the map
 *  asked for so a new auth config still triggers one more upgrade. */
const authConfigUpgradeAttempted = new Set<string>();

/** A Session cannot be edited, so one that lacks multi-account or the
 *  project's current auth configs is replaced (once per shortfall). */
function sessionReady(session: ComposioSession, authConfigs: AuthConfigMap) {
  return (session.multiAccountConfigured || multiAccountUpgradeAttempted.has(session.sessionId))
    && (sessionCoversAuthConfigs(session, authConfigs) || authConfigUpgradeAttempted.has(authConfigsKey(session.sessionId, authConfigs)));
}

/** A Session's MCP URL and headers are fixed for its id, so the relay reuses a
 *  recent verification. Keyed by the session_id D1 returned, so a replaced
 *  Session never hits a stale entry. */
const VERIFIED_SESSION_TTL_MS = 5 * 60_000;
const VERIFIED_SESSION_LIMIT = 1_000;
const verifiedSessions = new Map<string, { session: ComposioSession; verifiedAt: number }>();

function rememberSession(session: ComposioSession) {
  verifiedSessions.delete(session.sessionId);
  verifiedSessions.set(session.sessionId, { session, verifiedAt: Date.now() });
  // Maps iterate in insertion order, so the oldest entries go first.
  for (const sessionId of verifiedSessions.keys()) {
    if (verifiedSessions.size <= VERIFIED_SESSION_LIMIT) break;
    verifiedSessions.delete(sessionId);
  }
}

function forgetSession(sessionId: string) {
  verifiedSessions.delete(sessionId);
}

function verifiedSession(installation: InstallationRow) {
  const sessionId = installation.session_id;
  if (!sessionId) return undefined;
  const entry = verifiedSessions.get(sessionId);
  if (entry && entry.session.userId === actingUser(installation) && Date.now() - entry.verifiedAt < VERIFIED_SESSION_TTL_MS) return entry.session;
  verifiedSessions.delete(sessionId);
  return undefined;
}

/** last_seen_at only shows an installation is still in use; ten minutes is
 *  precise enough for the idle-installation sweep. */
const LAST_SEEN_INTERVAL_MS = 10 * 60_000;

function touchLastSeen(installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const now = Date.now();
  if (now - (installation.last_seen_at ?? 0) < LAST_SEEN_INTERVAL_MS) return;
  installation.last_seen_at = now;
  ctx.waitUntil(
    env.DB.prepare("UPDATE installations SET last_seen_at = ? WHERE id = ?")
      .bind(now, installation.id)
      .run()
      .catch((error: Error) => console.error(JSON.stringify({ message: "last-seen update failed", id: installation.id, error: error.message }))),
  );
}

async function limitSessionRequests(installation: InstallationRow, env: Env) {
  if (!(await env.SESSION_LIMITER.limit({ key: installation.id })).success) {
    throw new Response(JSON.stringify({ error: "too many connected-app requests" }), { status: 429, headers: JSON_HEADERS });
  }
}

async function ensureSession(installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  await limitSessionRequests(installation, env);
  return verifySession(installation, env, ctx);
}

async function currentInstallation(env: Env, id: string) {
  const current = await env.DB.prepare("SELECT * FROM installations WHERE id = ?").bind(id).first<InstallationRow>();
  if (!current || current.disabled_at !== null) throw json({ error: "unauthorized" }, 401);
  return current;
}

async function verifySession(installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const authConfigs = await projectAuthConfigs(env);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const user = actingUser(installation);
    let session = installation.session_id ? await getSession(env, installation.session_id) : null;
    if (session && sessionReady(session, authConfigs) && session.userId === user) {
      const current = await currentInstallation(env, installation.id);
      if (actingUser(current) !== user) {
        Object.assign(installation, current);
        continue;
      }
      touchLastSeen(installation, env, ctx);
    } else {
      session = await createSession(env, user, authConfigs);
      multiAccountUpgradeAttempted.add(session.sessionId);
      authConfigUpgradeAttempted.add(authConfigsKey(session.sessionId, authConfigs));
      const userColumn = installation.shared_user_id === undefined ? "composio_user_id" : "COALESCE(shared_user_id, composio_user_id)";
      const saved = await env.DB.prepare(
        `UPDATE installations SET session_id = ?, last_seen_at = ? WHERE id = ? AND ${userColumn} = ? AND disabled_at IS NULL`,
      ).bind(session.sessionId, Date.now(), installation.id, user).run();
      if (!saved.meta.changes) {
        Object.assign(installation, await currentInstallation(env, installation.id));
        continue;
      }
      installation.session_id = session.sessionId;
    }
    rememberSession(session);
    return session;
  }
  throw json({ error: "Connected apps changed. Try again." }, 503);
}

async function authenticate(request: Request, env: Env) {
  const token = request.headers.get("authorization")?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  if (!token) return null;
  // Every column, so a database that has not run a later migration still answers.
  const row = await env.DB.prepare("SELECT * FROM installations WHERE token_hash = ?").bind(await sha256(token)).first<InstallationRow>();
  return row && row.disabled_at === null ? row : null;
}

async function register(request: Request, env: Env) {
  if (env.REGISTRATION_MODE !== "open") return json({ error: "registration is temporarily closed" }, 503);
  const fingerprint = `${request.headers.get("cf-connecting-ip") ?? "unknown"}|${request.headers.get("user-agent") ?? "unknown"}`;
  if (!(await env.REGISTRATION_LIMITER.limit({ key: await sha256(fingerprint.slice(0, 512)) })).success) {
    return json({ error: "too many registration attempts" }, 429);
  }
  const installationId = crypto.randomUUID();
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO installations (id, token_hash, composio_user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(installationId, await sha256(token), `omb_${installationId.replaceAll("-", "")}`, now, now).run();
  console.log(JSON.stringify({ message: "installation registered", installationId }));
  return json({ installationId, token }, 201);
}

async function proxyMcp(request: Request, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const body = await readBoundedBody(request, MAX_MCP_BODY);
  if (!body) return json({ error: "MCP request is too large" }, 413);
  await limitSessionRequests(installation, env);
  Object.assign(installation, await currentInstallation(env, installation.id));
  const reused = verifiedSession(installation);
  if (reused) touchLastSeen(installation, env, ctx);
  let session = reused ?? await verifySession(installation, env, ctx);
  const incomingMcpSession = request.headers.get("mcp-session-id");
  const forward = (target: ComposioSession) => {
    const upstreamHeaders = new Headers(target.headers);
    upstreamHeaders.set("x-api-key", env.COMPOSIO_API_KEY);
    upstreamHeaders.set("content-type", request.headers.get("content-type") ?? "application/json");
    upstreamHeaders.set("accept", "application/json, text/event-stream");
    if (incomingMcpSession) upstreamHeaders.set("mcp-session-id", incomingMcpSession);
    return fetch(target.url, {
      method: "POST",
      headers: upstreamHeaders,
      body,
      signal: AbortSignal.timeout(10 * 60_000),
    }).catch((error: unknown) => {
      forgetSession(target.sessionId);
      throw error;
    });
  };
  let response = await forward(session);
  if (reused && !incomingMcpSession && (response.status === 404 || response.status === 410)) {
    // Composio dropped the Session after this isolate verified it. Without an
    // mcp-session-id the client has nothing to re-initialize, so look the
    // Session up again and resend once (a 404 or 410 from the MCP URL
    // dispatched nothing). With one, the 404 passes through.
    forgetSession(session.sessionId);
    await response.body?.cancel();
    session = await verifySession(installation, env, ctx);
    response = await forward(session);
  }
  // Any upstream failure may mean the Session went bad, so look it up again
  // on the next message.
  if (!response.ok) forgetSession(session.sessionId);
  const headers = new Headers({
    "content-type": response.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
  });
  const mcpSession = response.headers.get("mcp-session-id");
  if (mcpSession) headers.set("mcp-session-id", mcpSession);
  return new Response(response.body, { status: response.status, headers });
}

async function catalog(env: Env, url: URL) {
  // The catalog runs past a thousand toolkits, so pass the caller's cursor through.
  const params = new URLSearchParams({ limit: "500", sort_by: "usage" });
  const cursor = url.searchParams.get("cursor");
  if (cursor && CATALOG_CURSOR.test(cursor)) params.set("cursor", cursor);
  const response = await fetch(`${env.COMPOSIO_TOOLKIT_BASE}/toolkits?${params}`, {
    headers: { accept: "application/json", "x-api-key": env.COMPOSIO_API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return json({ error: await upstreamError(response, "Catalog unavailable") }, 502);
  return new Response(response.body, {
    headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "private, max-age=600" },
  });
}

async function listSessionToolkits(
  env: Env,
  sessionId: string,
): Promise<ToolkitItem[]> {
  const toolkits: ToolkitItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    // Avoid walking the full marketplace just to render the Connected tab.
    // Composio supports a server-side connected-only filter on this route.
    const params = new URLSearchParams({ limit: "50", is_connected: "true" });
    if (cursor) params.set("cursor", cursor);
    const response = await composioRequest(
      env,
      `/tool_router/session/${encodeURIComponent(sessionId)}/toolkits?${params}`,
    );
    if (!response.ok) throw new Error(await upstreamError(response, "Toolkit inventory unavailable"));
    const body = toolkitPageSchema.parse(await response.json());
    toolkits.push(...(body.items ?? []));
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return toolkits;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Toolkit inventory exceeded the pagination safety limit");
}

function summarizeAccounts(accounts: ConnectedAccountResponse[], slugs: string[]) {
  const requested = new Set(slugs.map((slug) => slug.toLowerCase()));
  const bySlug = new Map<string, Array<ConnectedAccountSummary & { updatedAt: string }>>();
  for (const account of accounts) {
    const slug = account.toolkit?.slug?.toLowerCase();
    if (!slug || (requested.size && !requested.has(slug)) || !account.id || !ACCOUNT_ID.test(account.id)) continue;
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

function serviceStateFromAccounts(accounts: ConnectedAccountSummary[]): ConnectorServiceState {
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
    const slug = toolkit.slug?.toLowerCase();
    const selected = toolkit.connected_account;
    const selectedId = selected?.id && ACCOUNT_ID.test(selected.id) ? selected.id : undefined;
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

async function connectedServices(
  installation: InstallationRow,
  env: Env,
  ctx: ExecutionContext,
) {
  const session = await ensureSession(installation, env, ctx);
  const [toolkits, accounts] = await Promise.all([
    listSessionToolkits(env, session.sessionId),
    listConnectedAccounts(env, actingUser(installation), []).catch(() => []),
  ]);
  return json({
    configured: true,
    services: allServiceStates(summarizeAccounts(accounts, []), toolkits),
  });
}

async function connectionStatus(url: URL, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const slugs = [...new Set((url.searchParams.get("services") ?? "").split(",").map((slug) => slug.toLowerCase()).filter(Boolean))].slice(0, 50);
  const session = await ensureSession(installation, env, ctx);
  const [response, accounts] = await Promise.all([
    composioRequest(
      env,
      `/tool_router/session/${encodeURIComponent(session.sessionId)}/toolkits?${new URLSearchParams({ limit: "50", toolkits: slugs.join(",") })}`,
    ),
    listConnectedAccounts(env, actingUser(installation), slugs).catch(() => []),
  ]);
  if (!response.ok) return json({ error: await upstreamError(response, "Connection status unavailable") }, 502);
  const body = toolkitPageSchema.parse(await response.json());
  const items = new Map((body.items ?? []).map((item) => [item.slug?.toLowerCase(), item]));
  const accountsBySlug = summarizeAccounts(accounts, slugs);
  return json({ services: Object.fromEntries(slugs.map((slug) => {
    const item = items.get(slug);
    const serviceAccounts = accountsBySlug.get(slug) ?? [];
    const accountState = serviceStateFromAccounts(serviceAccounts);
    const status = item?.connected_account?.status ?? (item?.is_no_auth ? "ACTIVE" : accountState.status);
    return [slug, {
      connected: item?.is_no_auth === true || accountState.connected || /^active$/i.test(status),
      pending: accountState.pending || /^(initiated|initializing|pending)$/i.test(status),
      status,
      accounts: accountState.accounts,
    }];
  })) });
}

async function authorize(
  slug: string,
  alias: string | undefined,
  installation: InstallationRow,
  env: Env,
  ctx: ExecutionContext,
) {
  const session = await ensureSession(installation, env, ctx);
  // Listing can be denied to the broker's key scope; authorize must still
  // work, with the alias guardrails degrading to first-account behavior.
  const accounts = await listConnectedAccounts(env, actingUser(installation), [slug]).catch(() => []);
  const serviceAccounts = accounts.filter((account) => account.toolkit?.slug?.toLowerCase() === slug);
  const plan = planAccountLink(
    slug,
    serviceAccounts,
    alias,
    MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit,
    () => `omb-retry-${crypto.randomUUID()}`,
  );
  if (!plan.ok) return json({ error: plan.error }, plan.status);
  for (const id of plan.replace) {
    const removed = await composioRequest(env, `/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`, { method: "DELETE" });
    if (!removed.ok) return json({ error: await upstreamError(removed, "Removing the earlier sign-in failed") }, 502);
  }
  const linkRequest: AccountLinkRequest = { toolkit: slug };
  if (plan.alias) linkRequest.alias = plan.alias;
  const response = await composioRequest(env, `/tool_router/session/${encodeURIComponent(session.sessionId)}/link`, {
    method: "POST",
    body: JSON.stringify(linkRequest),
  });
  if (!response.ok) return json({ error: await upstreamError(response, "Authorization unavailable") }, 502);
  const body = linkResponseSchema.parse(await response.json());
  if (!body.redirect_url) return json({ error: "Composio returned no authorization link" }, 502);
  const redirect = new URL(body.redirect_url);
  if (redirect.protocol !== "https:" || (redirect.hostname !== "composio.dev" && !redirect.hostname.endsWith(".composio.dev"))) {
    return json({ error: "Composio returned an untrusted authorization link" }, 502);
  }
  return json({ url: redirect.toString() });
}

async function disconnect(slug: string, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const session = await ensureSession(installation, env, ctx);
  const list = await composioRequest(
    env,
    `/tool_router/session/${encodeURIComponent(session.sessionId)}/toolkits?${new URLSearchParams({ limit: "50", toolkits: slug })}`,
  );
  if (!list.ok) return json({ error: await upstreamError(list, "Connection lookup unavailable") }, 502);
  const body = toolkitPageSchema.parse(await list.json());
  const id = body.items?.find((item) => item.slug?.toLowerCase() === slug)?.connected_account?.id;
  if (!id) return json({ removed: 0 });
  const response = await composioRequest(env, `/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`, { method: "DELETE" });
  if (!response.ok) return json({ error: await upstreamError(response, "Disconnect failed") }, 502);
  return json({ removed: 1 });
}

async function disconnectAccount(
  slug: string,
  accountId: string,
  installation: InstallationRow,
  env: Env,
  ctx: ExecutionContext,
) {
  if (!ACCOUNT_ID.test(accountId)) return json({ error: "Invalid connected-account ID" }, 400);
  await ensureSession(installation, env, ctx);
  const accounts = await listConnectedAccounts(env, actingUser(installation), [slug]);
  const owned = accounts.some((account) =>
    account.id === accountId && account.toolkit?.slug?.toLowerCase() === slug
  );
  if (!owned) return json({ removed: 0 });
  const response = await composioRequest(
    env,
    `/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`,
    { method: "DELETE" },
  );
  if (!response.ok) return json({ error: await upstreamError(response, "Disconnect failed") }, 502);
  return json({ removed: 1 });
}

async function requestAlias(request: Request) {
  if (!request.body) return undefined;
  const bytes = await readBoundedBody(request, 2048);
  if (!bytes) throw new Response(JSON.stringify({ error: "request body is too large" }), { status: 413, headers: JSON_HEADERS });
  let body: z.infer<typeof aliasRequestSchema>;
  try {
    const raw = new TextDecoder().decode(bytes);
    // Some Fetch implementations expose a zero-length POST as a non-null
    // ReadableStream. First-account authorization intentionally has no alias,
    // so accept that wire representation exactly like a missing body.
    if (!raw.trim()) return undefined;
    body = aliasRequestSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400, headers: JSON_HEADERS });
  }
  try {
    return normalizeAccountAlias(body.alias);
  } catch (error) {
    throw new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), { status: 400, headers: JSON_HEADERS });
  }
}

const TRIGGER_PATH = /^\/v1\/triggers\/([A-Za-z0-9_-]{1,128})$/;
const TRIGGER_TYPE_PATH = /^\/v1\/trigger-types\/([A-Za-z0-9_]{1,128})$/;

/** The app-event routes, or null for any other path. */
async function appEventRoute(request: Request, url: URL, installation: InstallationRow, env: Env, ctx: ExecutionContext) {
  const { method } = request;
  const path = url.pathname;
  const triggerMatch = path.match(TRIGGER_PATH);
  const typeMatch = path.match(TRIGGER_TYPE_PATH);
  const known = path === "/v1/events" || path === "/v1/events/test" || path === "/v1/installation/cloud"
    || path === "/v1/triggers" || path === "/v1/trigger-types" || triggerMatch || typeMatch;
  if (!known) return null;
  const events = await eventInstallation(env, installation.id);
  if (!events) return json({ error: "unauthorized" }, 401);
  if (method === "GET" && path === "/v1/events") return pollEvents(request, url, events, env, ctx);
  if (method === "POST" && path === "/v1/events/test") return queueTestEvent(request, events, env);
  if (method === "PUT" && path === "/v1/installation/cloud") return presentCloudGrant(request, events, env);
  await limitSessionRequests(installation, env);
  if (method === "GET" && path === "/v1/trigger-types") return listTriggerTypes(url, events, env);
  if (method === "GET" && typeMatch) return getTriggerType(typeMatch[1], env);
  if (method === "GET" && path === "/v1/triggers") return listTriggers(events, env);
  if (method === "POST" && path === "/v1/triggers") return createTrigger(request, events, env);
  if (method === "PATCH" && triggerMatch) return updateTrigger(request, triggerMatch[1], events, env);
  if (method === "DELETE" && triggerMatch) return deleteTrigger(triggerMatch[1], events, env);
  return json({ error: "not found" }, 404);
}

async function route(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return json({ service: "openmausbot-composio", ready: Boolean(env.COMPOSIO_API_KEY) });
  if (request.method === "POST" && url.pathname === "/v1/installations") return register(request, env);
  if (request.method === "POST" && url.pathname === "/v1/composio/webhook") return composioWebhook(request, env, ctx);
  if (request.method === "GET" && url.pathname === "/v1/stats/app-events") return appEventStats(request, url, env);
  if (!url.pathname.startsWith("/v1/")) return json({ error: "not found" }, 404);
  const installation = await authenticate(request, env);
  if (!installation) return json({ error: "unauthorized" }, 401);
  const appEvents = await appEventRoute(request, url, installation, env, ctx);
  if (appEvents) return appEvents;
  if (request.method === "GET" && url.pathname === "/v1/me") return me(installation);
  if (request.method === "POST" && url.pathname === "/v1/installation/share") return shareUser(request, installation, env);
  if (request.method === "POST" && url.pathname === "/v1/installation/adopt") {
    const adopted = await adoptSharedUser(request, installation, env);
    if (adopted.ok) forgetSession(installation.session_id ?? "");
    return adopted.response;
  }
  if (request.method === "POST" && url.pathname === "/v1/mcp") return proxyMcp(request, installation, env, ctx);
  if (request.method === "GET" && url.pathname === "/v1/catalog") return catalog(env, url);
  if (request.method === "GET" && url.pathname === "/v1/connectors/connected") return connectedServices(installation, env, ctx);
  if (request.method === "GET" && url.pathname === "/v1/connectors") return connectionStatus(url, installation, env, ctx);
  const accountMatch = url.pathname.match(/^\/v1\/connectors\/([a-z0-9_][a-z0-9_-]{0,80})\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
  if (accountMatch && request.method === "DELETE") {
    return disconnectAccount(accountMatch[1], accountMatch[2], installation, env, ctx);
  }
  // Composio prefixes slugs that would otherwise start with a digit, so
  // 1Password is `_1password` and 21RISK is `_21risk`. Admitting a leading
  // underscore keeps those toolkits reachable instead of 404ing here.
  const match = url.pathname.match(/^\/v1\/connectors\/([a-z0-9_][a-z0-9_-]{0,80})(?:\/(authorize))?$/);
  if (match?.[2] && request.method === "POST") return authorize(match[1], await requestAlias(request), installation, env, ctx);
  if (match && !match[2] && request.method === "DELETE") return disconnect(match[1], installation, env, ctx);
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof Response) return error;
      console.error(JSON.stringify({ message: "request failed", path: new URL(request.url).pathname, error: error instanceof Error ? error.message : String(error) }));
      return json({ error: "service unavailable" }, 503);
    }
  },
  async scheduled(controller: ScheduledController, env: Env) {
    await runHourly(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;

export {
  authorize,
  catalog,
  connectedServices,
  connectionStatus,
  createSession,
  disconnectAccount,
  ensureSession,
  listCustomAuthConfigs,
  normalizeAccountAlias,
  parseSession,
  requestAlias,
  sha256,
};
