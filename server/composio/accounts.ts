// Connected-account inventory and lifecycle: service status, disconnects
// and authorization links across the managed broker and project Sessions.
import { z } from "zod";
import type { AppConfig } from "../config.ts";
import { managedConnectorUnavailableReason } from "../../shared/connector-availability.ts";
import {
  apiBase,
  canonicalServiceRecord,
  canonicalToolkitSlug,
  connectionMode,
  MAX_CONNECTED_ACCOUNT_PAGES,
  printableAliasSchema,
  projectApiKey,
  requestedServiceRecord,
  type ConnectedAccountSummary,
  type ConnectorServiceState,
} from "./state.ts";
import {
  brokerRequest,
  inputError,
  projectHeaders,
  responseError,
  throwBrokerError,
  trustedAuthUrl,
} from "./broker.ts";
import {
  ensureProjectSession,
  listCustomAuthConfigs,
  MULTI_ACCOUNT_CONFIG,
  normalizeAccountAlias,
  recreateProjectSession,
  validAccountId,
} from "./sessions.ts";

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

/** Composio's wording when a toolkit has no managed auth and the Session was
 *  not told which of the project's own auth configs to use. */
const NEEDS_AUTH_CONFIG = /does not manage auth|auth[_ ]?config/i;

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
