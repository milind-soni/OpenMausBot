// The OpenConnector backend: a local or self-hosted oomol-lab/open-connector runtime serving /v1
// actions. OpenMausBot keeps only the runtime URL, a reference to the admin token, and this host's
// connection aliases/labels (OpenConnectorStateStore); credentials stay on the runtime.
import { DATA_DIR, type AppConfig } from "../../config.ts";
import type { BrokerAccess } from "../../composio-broker-access.ts";
import { canonicalToolkitSlug } from "../../composio-project.ts";
import type {
  CatalogPagination,
  ConnectorCatalog,
  ConnectorProvider,
  ConnectorServiceState,
  ConnectorToolListing,
  ConnectedServicesInventory,
  JsonValue,
} from "../types.ts";
import { join } from "node:path";
import { normalizeAccountAlias } from "../common.ts";
import { OpenConnectorClient, OpenConnectorError, normalizeOpenConnectorBaseUrl, type OpenConnectorActionItem } from "./client.ts";
import { OpenConnectorStateStore, OPENCONNECTOR_STATE_FILE, accountIdForConnection, isConnectedConnectionRecord, type OpenConnectorConnectionRecord } from "./state.ts";
import { pollConnectionRequest } from "./oauth.ts";
import { actionIdForConnectorTool, connectorToolListingForAction } from "./tools.ts";
import { OPENCONNECTOR_ADMIN_TOKEN_ENV, resolveTokenRef, type OpenConnectorSettings } from "../provider.ts";

const MCP_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;

export interface OpenConnectorProviderOptions {
  settings: OpenConnectorSettings;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  state?: OpenConnectorStateStore;
  /** Background authorization polling; defaults come from pollConnectionRequest. */
  polling?: { intervalMs?: number; timeoutMs?: number; resumeIntervalMs?: number };
}

class OpenConnectorConfigurationError extends Error {}

export function resolveAdminToken(settings: OpenConnectorSettings, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromRef = resolveTokenRef(settings.adminTokenRef, env);
  if (fromRef) return fromRef;
  return env[OPENCONNECTOR_ADMIN_TOKEN_ENV]?.trim() || undefined;
}

export function createOpenConnectorProvider(options: OpenConnectorProviderOptions): ConnectorProvider {
  const env = options.env ?? process.env;
  const runtimeConfigurationError = (() => {
    if (!options.settings.url?.trim()) return new OpenConnectorConfigurationError("OpenConnector is selected but has no URL; set OMB_OPENCONNECTOR_URL");
    try {
      normalizeOpenConnectorBaseUrl(options.settings.url);
      return undefined;
    } catch (error) {
      return new OpenConnectorConfigurationError(error instanceof Error && error.message ? error.message : "OpenConnector URL is invalid");
    }
  })();
  const runtimeUrl = options.settings.url && !runtimeConfigurationError ? normalizeOpenConnectorBaseUrl(options.settings.url) : "";
  const state = options.state ?? new OpenConnectorStateStore(join(DATA_DIR, OPENCONNECTOR_STATE_FILE), runtimeUrl);
  const pollsInFlight = new Map<string, Promise<void>>();
  const deferredPolls = new Map<string, ReturnType<typeof setTimeout>>();
  const resumeIntervalMs = options.polling?.resumeIntervalMs ?? 30_000;
  const actionDetailCache = new Map<string, OpenConnectorActionItem>();
  const fetchedActionDetails = new Set<string>();
  let disposed = false;

  const client = () => new OpenConnectorClient({
    baseUrl: options.settings.url ?? "",
    adminToken: (() => {
      if (runtimeConfigurationError) throw runtimeConfigurationError;
      const token = resolveAdminToken(options.settings, env);
      if (!token) {
        throw new OpenConnectorConfigurationError("OpenConnector is selected but has no admin token; set OMB_OPENCONNECTOR_ADMIN_TOKEN or OMB_OPENCONNECTOR_ADMIN_TOKEN_REF");
      }
      return token;
    })(),
    fetch: options.fetch,
  });

  const rejectMemberInstallation = (access: BrokerAccess | undefined, action: string): void => {
    if (access) throw new Error(`OpenConnector does not yet support member-scoped credentials; use an administrator installation to ${action}`);
  };

  const available = () => {
    if (runtimeConfigurationError) return false;
    try {
      return Boolean(resolveAdminToken(options.settings, env));
    } catch {
      return false;
    }
  };

  const clearDeferredPoll = (requestId: string): void => {
    const timer = deferredPolls.get(requestId);
    if (!timer) return;
    clearTimeout(timer);
    deferredPolls.delete(requestId);
  };

  const deferPoll = (service: string, requestId: string, alias: string | undefined): void => {
    if (disposed || pollsInFlight.has(requestId) || deferredPolls.has(requestId)) return;
    const timer = setTimeout(() => {
      deferredPolls.delete(requestId);
      if (available()) convergeConnection(service, requestId, alias);
      else deferPoll(service, requestId, alias);
    }, resumeIntervalMs);
    deferredPolls.set(requestId, timer);
  };

  /** Converge one authorization request in the background: the person authorizes in the browser
   * while the local record walks pending -> connected/failed on its own. One poll per request id;
   * a failed convergence never changes what authorize already returned, it only marks the record. */
  const convergeConnection = (service: string, requestId: string, alias: string | undefined): void => {
    if (disposed) return;
    clearDeferredPoll(requestId);
    if (pollsInFlight.has(requestId)) return;
    if (!available()) {
      deferPoll(service, requestId, alias);
      return;
    }
    const accountId = accountIdForConnection(service, alias);
    const run = pollConnectionRequest(client(), state, service, requestId, alias, {
      intervalMs: options.polling?.intervalMs,
      timeoutMs: options.polling?.timeoutMs,
    }).then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof OpenConnectorConfigurationError) {
          deferPoll(service, requestId, alias);
          return;
        }
        try {
          state.updateConnectionIf(accountId, requestId, (record) =>
            record.status === "connected" ? null : {
              ...record,
              status: "error",
              lastError: error instanceof Error ? error.message.slice(0, 400) : "authorization polling failed",
              updatedAt: new Date().toISOString(),
            });
        } catch {
          // A replaced runtime, stale CAS or removed record means this poll no longer owns the row.
        }
      },
    ).catch(() => undefined).finally(() => {
      pollsInFlight.delete(requestId);
    });
    pollsInFlight.set(requestId, run);
  };

  // Authorization can outlive the process. Restarted polls converge persisted requests; the request
  // guard in pollConnectionRequest keeps a stale poll from overwriting a newer authorization.
  for (const record of state.listConnections()) {
    if (record.status === "pending" && record.connectionRequestId) {
      convergeConnection(record.service, record.connectionRequestId, record.alias);
    }
  }



  const serviceStates = (services: readonly string[], authenticated: ReadonlySet<string>): Record<string, ConnectorServiceState> => {
    const connectionsByService = new Map<string, OpenConnectorConnectionRecord[]>();
    for (const record of state.listConnections()) {
      const records = connectionsByService.get(record.service) ?? [];
      records.push(record);
      connectionsByService.set(record.service, records);
    }
    return Object.fromEntries(services.map((service) => {
      const slug = canonicalToolkitSlug(service);
      const records = connectionsByService.get(slug) ?? [];
      const accounts = records
        .map((record) => ({
          id: record.accountId,
          status: record.status === "connected" ? "ACTIVE" : record.status,
          ...(record.alias ? { alias: record.alias } : {}),
        }));
      const pending = records.some((record) => record.status === "pending");
      const connected = authenticated.has(slug);
      return [slug, {
        connected,
        pending: pending && !connected,
        status: connected ? "ACTIVE" : pending ? "pending" : "not_connected",
        accounts,
      }];
    }));
  };

  const notFound = (error: unknown) => error instanceof OpenConnectorError && (error.status === 404 || error.code === "connection_not_found" || error.code === "unknown_action");

  const actionAliasFor = (actionId: string, params: Record<string, unknown>): string | undefined => {
    const requested = selectedAccountAlias(params);
    const service = canonicalToolkitSlug(actionId.slice(0, actionId.indexOf(".")));
    const records = state.connectionsForService(service).filter(isConnectedConnectionRecord);
    if (requested) {
      const record = records.find((item) => item.alias?.toLowerCase() === requested.toLowerCase());
      if (!record) throw new Error(`No selected OpenConnector account named "${requested}" for ${service}`);
      return record.alias;
    }
    if (records.length > 1) throw new Error(`Multiple OpenConnector accounts are connected for ${service}; select one with _meta.openconnectorAccountAlias`);
    return undefined;
  };

  const inventory = async (as?: BrokerAccess): Promise<ConnectedServicesInventory> => {
    rejectMemberInstallation(as, "list connector services");
    try {
      const providers = await client().providers();
      const slugs = providers.map((provider) => canonicalToolkitSlug(provider.service));
      const authenticated = new Set((await client().authenticatedServices(slugs)).map(canonicalToolkitSlug));
      return { services: serviceStates(slugs, authenticated), complete: true };
    } catch (error) {
      if (!(error instanceof OpenConnectorConfigurationError)) throw error;
      return { services: {}, complete: true };
    }
  };

  const detailedActionsForRelay = async (actions: readonly OpenConnectorActionItem[]): Promise<OpenConnectorActionItem[]> => {
    const detailed = actions.map((action) => fetchedActionDetails.has(action.id) ? actionDetailCache.get(action.id) ?? action : action);
    const missing = detailed
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => !fetchedActionDetails.has(action.id) && (!(action.raw.inputSchema instanceof Object) || Array.isArray(action.raw.inputSchema)));
    const runtime = client();
    for (let offset = 0; offset < missing.length; offset += 8) {
      const batch = missing.slice(offset, offset + 8);
      const settled = await Promise.allSettled(batch.map(({ action }) => runtime.action(action.id)));
      for (const [position, result] of settled.entries()) {
        if (result.status !== "fulfilled") continue;
        const { index, action } = batch[position];
        detailed[index] = result.value;
        actionDetailCache.set(action.id, result.value);
        fetchedActionDetails.add(action.id);
      }
    }
    return detailed;
  };

  return {
    id: "openconnector",
    mode: () => (available() ? "self-hosted" : "unavailable"),
    isConfigured: () => available(),

    inventory: (_cfg: AppConfig, as?: BrokerAccess) => inventory(as),

    dispose: () => {
      disposed = true;
      for (const requestId of deferredPolls.keys()) clearDeferredPoll(requestId);
    },

    async tools(): Promise<Record<string, ConnectorToolListing[]>> {
      try {
        const actions = await client().actions();
        const grouped = new Map<string, ConnectorToolListing[]>();
        for (const action of actions) {
          const listing = connectorToolListingForAction(action);
          if (!listing) continue;
          const row: ConnectorToolListing = {
            name: listing.name,
            ...(listing.description ? { description: listing.description } : {}),
            ...(listing.inputSchema ? { inputSchema: listing.inputSchema } : {}),
          };
          const bucket = grouped.get(listing.service) ?? [];
          if (!bucket.some((existing) => existing.name === row.name)) bucket.push(row);
          grouped.set(listing.service, bucket);
        }
        for (const bucket of grouped.values()) bucket.sort((a, b) => a.name.localeCompare(b.name));
        return Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)));
      } catch (error) {
        if (!(error instanceof OpenConnectorConfigurationError)) throw error;
        return {};
      }
    },

    async serviceSlugs(_cfg: AppConfig, as?: BrokerAccess): Promise<readonly string[]> {
      return Object.keys((await inventory(as)).services);
    },

    async status(_cfg: AppConfig, slugs: string[], as?: BrokerAccess): Promise<Record<string, ConnectorServiceState>> {
      rejectMemberInstallation(as, "read connector status");
      const canonical = [...new Set(slugs.map(canonicalToolkitSlug))];
      let authenticated: ReadonlySet<string>;
      try {
        authenticated = new Set((await client().authenticatedServices(canonical)).map(canonicalToolkitSlug));
      } catch (error) {
        if (!(error instanceof OpenConnectorConfigurationError)) throw error;
        const states = serviceStates(canonical, new Set());
        return Object.fromEntries(Object.entries(states).map(([slug, state]) => [
          slug,
          { ...state, status: state.pending ? "pending" : "setup-needed" },
        ]));
      }
      const states = serviceStates(canonical, authenticated);
      return Object.fromEntries(slugs.map((slug) => {
        const state = states[canonicalToolkitSlug(slug)];
        return [slug, state ?? { connected: false, pending: false, status: "not_connected", accounts: [] }];
      }));
    },

    async removeService(_cfg: AppConfig, slug: string, as?: BrokerAccess): Promise<{ removed: number }> {
      rejectMemberInstallation(as, "remove a connector service");
      const service = canonicalToolkitSlug(slug);
      const knownAliases = [...new Set(state.connectionsForService(service).map((record) => record.alias))];
      const aliases = knownAliases.includes(undefined) ? knownAliases : [undefined, ...knownAliases];
      let removed = 0;
      for (const alias of aliases) {
        try {
          await client().disconnect(service, alias);
          removed += 1;
        } catch (error) {
          if (!notFound(error)) throw error;
        }
      }
      state.removeConnectionsForService(service);
      return { removed };
    },

    async removeAccount(_cfg: AppConfig, slug: string, accountId: string): Promise<{ removed: number }> {
      const service = canonicalToolkitSlug(slug);
      const record = state.findConnectionByAccountId(accountId);
      if (!record || record.service !== service) return { removed: 0 };
      try {
        await client().disconnect(service, record.alias);
      } catch (error) {
        if (notFound(error)) {
          state.removeConnection(accountId);
          return { removed: 0 };
        }
        throw error;
      }
      state.removeConnection(accountId);
      return { removed: 1 };
    },

    async prepareAuthConfigs(): Promise<string | undefined> {
      // Per-app OAuth replaces Composio auth-config ids; nothing to preflight here.
      return undefined;
    },

    async authorize(_cfg: AppConfig, slug: string, requestedAlias?: string | null, as?: BrokerAccess) {
      rejectMemberInstallation(as, "authorize a connector service");
      const service = canonicalToolkitSlug(slug);
      const alias = normalizeAccountAlias(requestedAlias);
      const accountId = accountIdForConnection(service, alias);
      const expectedUpdatedAt = state.findConnectionByAccountId(accountId)?.updatedAt ?? null;
      const begun = await client().beginConnect(service);
      if (!begun.authorizationUrl) {
        throw new Error(`OpenConnector returned no authorization link for ${service}`);
      }
      state.upsertConnection({
        accountId,
        service,
        ...(alias ? { alias } : {}),
        ...(begun.connectionRequestId ? { connectionRequestId: begun.connectionRequestId } : {}),
        status: "pending",
        updatedAt: new Date().toISOString(),
      }, expectedUpdatedAt);
      if (begun.connectionRequestId) convergeConnection(service, begun.connectionRequestId, alias);
      return { url: begun.authorizationUrl, ...(begun.connectionRequestId ? { connectionRequestId: begun.connectionRequestId } : {}) };
    },

    async catalog(): Promise<ConnectorCatalog> {
      const providers = await client().providers();
      const cards = providers.map((provider) => ({
        slug: canonicalToolkitSlug(provider.service),
        label: provider.name ?? provider.service,
        blurb: (provider.description ?? "").slice(0, 90),
        logo: null,
        domain: null,
      }));
      const pagination: CatalogPagination = { items: cards.length, stalled: false, complete: true };
      return { cards, source: "api", pagination };
    },

    async relayMcp(
      _cfg: AppConfig,
      payload: JsonValue,
      // Accepted for interface parity and dropped: the translation is stateless per call, and one
      // runtime backend needs no MCP session affinity (known single-backend gap, not a fork).
      _transportSessionId?: string,
      beforeSend?: () => void,
      signal?: AbortSignal,
      as?: BrokerAccess,
    ) {
      rejectMemberInstallation(as, "call connector tools");
      return relayOpenConnectorMcp(client, payload, beforeSend, signal, actionAliasFor, detailedActionsForRelay);
    },
  };
}

type ClientFactory = () => OpenConnectorClient;

/** The MCP translation the harness's connector bridge speaks: the same JSON-RPC frame shapes the
 * Composio relay answers, but tools/list comes from GET /v1/actions and tools/call from
 * POST /v1/actions/:id. */
async function relayOpenConnectorMcp(
  client: ClientFactory,
  payload: JsonValue,
  beforeSend?: () => void,
  signal?: AbortSignal,
  accountAliasFor?: (actionId: string, params: Record<string, unknown>) => string | undefined,
  detailActionsFor?: (actions: readonly OpenConnectorActionItem[]) => Promise<OpenConnectorActionItem[]>,
): Promise<{ status: number; bytes: Uint8Array; contentType: string }> {
  const frame = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : null;
  const method = typeof frame?.method === "string" ? frame.method : undefined;
  const id = frame?.id ?? null;
  const encode = (body: unknown, status = 200) => {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    if (bytes.byteLength > MCP_OUTPUT_MAX_BYTES) {
      return { status: 502, bytes: new TextEncoder().encode(JSON.stringify(jsonRpcError(id, -32000, "Connected-app response exceeded 20 MB"))), contentType: "application/json" };
    }
    return { status, bytes, contentType: "application/json" };
  };
  const jsonRpcError = (rid: JsonValue, code: number, message: string) => ({ jsonrpc: "2.0", id: rid, error: { code, message } });

  if (method === "initialize") {
    const params = frame?.params && typeof frame.params === "object" ? frame.params as Record<string, unknown> : {};
    return encode({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "openconnector", version: "1" },
      },
    });
  }
  if (method?.startsWith("notifications/")) return encode({}, 202);
  if (method === "tools/list") {
    const actions = await client().actions();
    const detailedActions = await (detailActionsFor?.(actions) ?? client().actionDetails(actions));
    const tools = detailedActions
      .map((action) => connectorToolListingForAction(action))
      .filter((listing): listing is NonNullable<typeof listing> => listing !== null)
      .map((listing) => ({
        name: listing.name,
        ...(listing.description ? { description: listing.description } : {}),
        ...(listing.inputSchema ? { inputSchema: listing.inputSchema } : {}),
      }));
    return encode({ jsonrpc: "2.0", id, result: { tools } });
  }
  if (method === "tools/call") {
    const params = frame?.params && typeof frame.params === "object" ? frame.params as Record<string, unknown> : {};
    const name = typeof params.name === "string" ? params.name : "";
    const actions = await client().actions();
    const actionId = actionIdForConnectorTool(name, actions.map((action) => action.id));
    if (!actionId) return encode(jsonRpcError(id, -32602, `Unknown connector tool: ${name}`), 200);
    beforeSend?.();
    try {
      const alias = accountAliasFor?.(actionId, params);
      const data = await client().execute(actionId, params.arguments ?? {}, alias, signal);
      return encode({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(data) }], isError: false },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "OpenConnector action failed";
      return encode({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: message }], isError: true },
      });
    }
  }
  return encode(jsonRpcError(id ?? null, -32601, `Method not found: ${method ?? "none"}`), 200);
}

function selectedAccountAlias(params: Record<string, unknown>): string | undefined {
  const meta = params._meta;
  const alias = meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).openconnectorAccountAlias
    : undefined;
  return typeof alias === "string" && alias.trim() ? alias.trim() : undefined;
}
