// Composio Session lifecycle: auth-config discovery, create/reuse/recreate
// of the per-project Session, and alias/account-id validation.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { saveConfig, type AppConfig } from "../config.ts";
import {
  ACCOUNT_ID,
  apiBase,
  canonicalToolkitSlug,
  printableAliasSchema,
  projectApiKey,
} from "./state.ts";
import {
  getProjectSession,
  inputError,
  parseSessionResponse,
  projectHeaders,
  responseError,
  sessionResponseSchema,
  supportsMultiAccount,
  type SessionResponse,
} from "./broker.ts";

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
export type AuthConfigMap = Record<string, string>;
const MAX_AUTH_CONFIG_PAGES = 20;

export const MULTI_ACCOUNT_CONFIG = {
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

/** Session ids this boot already tried to upgrade once. If the fresh Session
 *  STILL doesn't echo multi-account, Composio isn't granting it — run with
 *  what we have (single-account behavior) instead of recreating a Session and
 *  rewriting config.json on every request. */
const multiAccountUpgradeAttempted = new Set<string>();
/** Session id + auth-config map pairs this boot already created a Session
 *  for. Same idea: if Composio does not echo `auth_configs`, recreating the
 *  Session on every check would loop without changing anything. */
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

export function validAccountId(value: string | undefined): value is string {
  return Boolean(value && ACCOUNT_ID.test(value));
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

export async function ensureProjectSession(cfg: AppConfig): Promise<SessionResponse> {
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
export async function recreateProjectSession(
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
