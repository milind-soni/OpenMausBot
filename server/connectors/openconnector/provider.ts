// The OpenConnector backend: a local or self-hosted oomol-lab/open-connector runtime serving /v1
// actions. OpenMausBot keeps only the runtime URL, a reference to the admin token, and this host's
// connection aliases/labels (OpenConnectorStateStore); credentials stay on the runtime.
import type { AppConfig } from "../../config.ts";
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
import { normalizeAccountAlias } from "../common.ts";
import { OpenConnectorClient, OpenConnectorError } from "./client.ts";
import { OpenConnectorStateStore, accountIdForConnection } from "./state.ts";
import { actionForConnectorTool, connectorToolListingForAction } from "./tools.ts";
import { OPENCONNECTOR_ADMIN_TOKEN_ENV, resolveTokenRef, type OpenConnectorSettings } from "../provider.ts";

const MCP_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;
const PROVIDER_LIST_CACHE_MS = 60_000;

export interface OpenConnectorProviderOptions {
  settings: OpenConnectorSettings;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  state?: OpenConnectorStateStore;
}

export function resolveAdminToken(settings: OpenConnectorSettings, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromRef = resolveTokenRef(settings.adminTokenRef, env);
  if (fromRef) return fromRef;
  return env[OPENCONNECTOR_ADMIN_TOKEN_ENV]?.trim() || undefined;
}

export function createOpenConnectorProvider(options: OpenConnectorProviderOptions): ConnectorProvider {
  const env = options.env ?? process.env;
  const state = options.state ?? new OpenConnectorStateStore();
  let providerListCache: { at: number; services: string[] } | null = null;

  const client = () => new OpenConnectorClient({
    baseUrl: options.settings.url ?? "",
    adminToken: resolveAdminToken(options.settings, env),
    fetch: options.fetch,
  });

  const available = () => Boolean(options.settings.url?.trim()) && Boolean(resolveAdminToken(options.settings, env));

  const serviceStates = (services: readonly string[], authenticated: ReadonlySet<string>): Record<string, ConnectorServiceState> =>
    Object.fromEntries(services.map((service) => {
      const slug = canonicalToolkitSlug(service);
      const accounts = state.connectionsForService(slug)
        .map((record) => ({
          id: record.accountId,
          status: record.status,
          ...(record.alias ? { alias: record.alias } : {}),
        }));
      const pending = state.connectionsForService(slug).some((record) => record.status === "pending");
      const connected = authenticated.has(slug);
      return [slug, {
        connected,
        pending: pending && !connected,
        status: connected ? "ACTIVE" : pending ? "pending" : "not_connected",
        accounts,
      }];
    }));

  const knownServices = async (): Promise<string[]> => {
    if (providerListCache && Date.now() - providerListCache.at < PROVIDER_LIST_CACHE_MS) {
      return providerListCache.services;
    }
    const services = (await client().providers()).map((provider) => canonicalToolkitSlug(provider.service));
    providerListCache = { at: Date.now(), services };
    return services;
  };

  const notFound = (error: unknown) => error instanceof OpenConnectorError && (error.status === 404 || error.code === "connection_not_found" || error.code === "unknown_action");

  const inventory = async (): Promise<ConnectedServicesInventory> => {
    const providers = await client().providers();
    const slugs = providers.map((provider) => canonicalToolkitSlug(provider.service));
    const authenticated = new Set((await client().authenticatedServices(slugs)).map(canonicalToolkitSlug));
    return { services: serviceStates(slugs, authenticated), complete: true };
  };

  return {
    id: "openconnector",
    mode: () => (available() ? "self-hosted" : "unavailable"),
    isConfigured: () => available(),

    inventory,

    async tools(): Promise<Record<string, ConnectorToolListing[]>> {
      const actions = await client().actions();
      const grouped = new Map<string, ConnectorToolListing[]>();
      for (const action of actions) {
        const listing = connectorToolListingForAction(action);
        if (!listing) continue;
        const row: ConnectorToolListing = {
          name: listing.name,
          ...(listing.description ? { description: listing.description } : {}),
        };
        const bucket = grouped.get(listing.service) ?? [];
        if (!bucket.some((existing) => existing.name === row.name)) bucket.push(row);
        grouped.set(listing.service, bucket);
      }
      for (const bucket of grouped.values()) bucket.sort((a, b) => a.name.localeCompare(b.name));
      return Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },

    async serviceSlugs(): Promise<readonly string[]> {
      return Object.keys((await inventory()).services);
    },

    async status(_cfg: AppConfig, slugs: string[]): Promise<Record<string, ConnectorServiceState>> {
      const canonical = [...new Set(slugs.map(canonicalToolkitSlug))];
      const authenticated = new Set((await client().authenticatedServices(canonical)).map(canonicalToolkitSlug));
      const states = serviceStates(canonical, authenticated);
      return Object.fromEntries(slugs.map((slug) => {
        const state = states[canonicalToolkitSlug(slug)];
        return [slug, state ?? { connected: false, pending: false, status: "not_connected", accounts: [] }];
      }));
    },

    async removeService(_cfg: AppConfig, slug: string): Promise<{ removed: number }> {
      const service = canonicalToolkitSlug(slug);
      try {
        await client().disconnect(service);
      } catch (error) {
        if (notFound(error)) return { removed: 0 };
        throw error;
      }
      state.removeConnectionsForService(service);
      return { removed: 1 };
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

    async authorize(_cfg: AppConfig, slug: string, requestedAlias?: string | null) {
      const service = canonicalToolkitSlug(slug);
      const alias = normalizeAccountAlias(requestedAlias);
      const begun = await client().beginConnect(service, alias);
      if (!begun.authorizationUrl) {
        throw new Error(`OpenConnector returned no authorization link for ${service}`);
      }
      state.upsertConnection({
        accountId: accountIdForConnection(service, alias),
        service,
        ...(alias ? { alias } : {}),
        ...(begun.connectionRequestId ? { connectionRequestId: begun.connectionRequestId } : {}),
        status: "pending",
        updatedAt: new Date().toISOString(),
      });
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
      _transportSessionId?: string,
      beforeSend?: () => void,
      signal?: AbortSignal,
    ) {
      return relayOpenConnectorMcp(client, knownServices, payload, beforeSend, signal);
    },
  };
}

type ClientFactory = () => OpenConnectorClient;

/** The MCP translation the harness's connector bridge speaks: the same JSON-RPC frame shapes the
 * Composio relay answers, but tools/list comes from GET /v1/actions and tools/call from
 * POST /v1/actions/:id. */
async function relayOpenConnectorMcp(
  client: ClientFactory,
  knownServices: () => Promise<string[]>,
  payload: JsonValue,
  beforeSend?: () => void,
  signal?: AbortSignal,
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
    const tools = actions
      .map((action) => connectorToolListingForAction(action))
      .filter((listing): listing is NonNullable<typeof listing> => listing !== null)
      .map((listing) => ({ name: listing.name, ...(listing.description ? { description: listing.description } : {}) }));
    return encode({ jsonrpc: "2.0", id, result: { tools } });
  }
  if (method === "tools/call") {
    const params = frame?.params && typeof frame.params === "object" ? frame.params as Record<string, unknown> : {};
    const name = typeof params.name === "string" ? params.name : "";
    const candidates = await knownServices();
    const actionId = actionForConnectorTool(name, candidates);
    if (!actionId) return encode(jsonRpcError(id, -32602, `Unknown connector tool: ${name}`), 200);
    beforeSend?.();
    try {
      const data = await client().execute(actionId, params.arguments ?? {}, undefined, signal);
      return encode({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(data) }], isError: false },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "OpenConnector action failed";
      const status = error instanceof OpenConnectorError ? error.status ?? 502 : 502;
      return encode(jsonRpcError(id, -32000, message), status >= 400 && status < 600 ? status : 502);
    }
  }
  return encode(jsonRpcError(id ?? null, -32601, `Method not found: ${method ?? "none"}`), 200);
}
