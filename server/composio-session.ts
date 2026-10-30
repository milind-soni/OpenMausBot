// A Composio project key (ak_…) creates or reuses one Tool Router Session, which owns connection state, auth links and the
// MCP endpoint. A PATCH replaces a Session's whole `auth_configs` map and keeps its id and MCP URL (API v3.1, Oct 2026):
// https://docs.composio.dev/reference/sdk-reference/python/session
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { saveConfig, type AppConfig } from "./config.ts";
import {
  apiBase,
  canonicalToolkitSlug,
  forgetProjectAuthConfigs,
  projectAuthConfigs,
  projectHeaders,
  responseError,
  turnOnToolRouter,
  type AuthConfigChoice,
  type AuthConfigMap,
} from "./composio-project.ts";

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
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const MULTI_ACCOUNT_CONFIG = {
  enable: true,
  max_accounts_per_toolkit: 5,
  require_explicit_selection: true,
} as const;

interface SessionCreateRequest {
  user_id: string;
  manage_connections: { enable: boolean; enable_wait_for_connections: boolean; enable_connection_removal: boolean };
  multi_account: typeof MULTI_ACCOUNT_CONFIG;
  /** Sent only when the project has configs: an empty map pins "no custom auth" for the Session. */
  auth_configs?: AuthConfigMap;
}

/** A user's own project key wins over the managed broker; "" means cleared, so the broker takes over again. */
export function projectApiKey(cfg: AppConfig): string | null {
  return cfg.composio?.apiKey?.trim() || null;
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
/** What Composio said when it refused a Session naming an auth config, by config id. */
const refusedAuthConfigs = new Map<string, string>();

export function authConfigRefusal(id: string): string | undefined {
  return refusedAuthConfigs.get(id);
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
 * may block the rest. */
async function createProjectSession(apiKey: string, userId: string, authConfigs: AuthConfigMap): Promise<string> {
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
  while (!res.ok && Object.keys(named).length && REFUSED_SESSION_STATUSES.has(res.status)) {
    const said = await responseError(res, `HTTP ${res.status}`);
    const kept = Object.fromEntries(Object.entries(named).filter(([, id]) => !said.includes(id)));
    const next = Object.keys(kept).length < Object.keys(named).length ? kept : {};
    for (const id of Object.values(named)) if (!Object.values(next).includes(id)) refusedAuthConfigs.set(id, said);
    named = next;
    console.warn(`[composio] Composio refused a Session naming the project's auth configs (${said}); creating it without them`);
    res = await post(named);
  }
  if (!res.ok) throw new Error(await responseError(res, `Composio rejected this key (HTTP ${res.status})`));
  const session = parseSessionResponse(sessionResponseSchema.parse(await res.json()));
  authConfigUpgradeAttempted.add(authConfigsKey(session.session_id, authConfigs));
  return session.session_id;
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
  const sessionId = await createProjectSession(trimmed, userId, authConfigs);
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

/** The same Session naming `configs`, so a bot mid-conversation keeps its MCP endpoint; null when Composio won't. */
async function nameAuthConfigsInPlace(apiKey: string, session: SessionResponse, configs: AuthConfigMap): Promise<SessionResponse | null> {
  const res = await fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(session.session_id)}`, {
    method: "PATCH",
    headers: projectHeaders(apiKey, true),
    body: JSON.stringify({ auth_configs: configs }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    console.warn(`[composio] Composio would not change the Session's auth configs (${await responseError(res, `HTTP ${res.status}`)}); making a new Session`);
    return null;
  }
  authConfigUpgradeAttempted.add(authConfigsKey(session.session_id, configs));
  return getProjectSession(apiKey, session.session_id);
}

export async function ensureProjectSession(cfg: AppConfig, wanted?: AuthConfigMap): Promise<SessionResponse> {
  const composio = cfg.composio;
  const apiKey = projectApiKey(cfg);
  if (!composio || !apiKey) throw new Error("No Composio project key configured");
  const configs = wanted ?? (await projectAuthConfigs(apiKey)).configs;
  if (composio.sessionId) {
    const existing = await getProjectSession(apiKey, composio.sessionId);
    if (existing && (supportsMultiAccount(existing) || multiAccountUpgradeAttempted.has(existing.session_id))) {
      if (authConfigsReady(existing, configs)) return existing;
      const named = await nameAuthConfigsInPlace(apiKey, existing, configs);
      if (named) return named;
    }
  }
  const prepared = await prepareProjectSession(apiKey, composio, configs);
  return adoptProjectSession(composio, apiKey, prepared.userId, prepared.sessionId);
}

export interface ToolkitSession {
  session: SessionResponse;
  /** The project's own auth config for the toolkit, now named in `session`; null when the project has none for it. */
  choice: AuthConfigChoice | null;
  readError?: string;
}

/** The Session, ready to connect `toolkit` with the project's own auth config for it when there is one. A fresh lookup that
 * finds none is not kept, so the next one sees a config made meanwhile. */
export async function sessionForToolkit(cfg: AppConfig, toolkit: string, options: { fresh?: boolean } = {}): Promise<ToolkitSession> {
  const apiKey = projectApiKey(cfg);
  if (!apiKey) throw new Error("No Composio project key configured");
  let project = await projectAuthConfigs(apiKey, options);
  const choice = project.choices[toolkit] ?? null;
  if (!choice && options.fresh) forgetProjectAuthConfigs(apiKey);
  if (choice && !choice.toolRouter) {
    await turnOnToolRouter(apiKey, toolkit, choice);
    project = await projectAuthConfigs(apiKey);
  }
  const session = await ensureProjectSession(cfg, project.configs);
  return { session, choice: project.choices[toolkit] ?? choice, ...(project.readError ? { readError: project.readError } : {}) };
}
