// The connected-apps facade every caller imports from. The backend lives behind the ConnectorProvider
// seam in ./connectors/: this module keeps the exported surface and the provider-agnostic logic
// (availability wording, grant validation, card fallbacks, the local MCP bridge), and delegates every
// backend call to the configured provider. Default provider is Composio, so an unconfigured host
// behaves exactly as before.
import type { AppConfig } from "./config.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { canonicalToolkitSlug, inputError } from "./composio-project.ts";
import type { ConnectorToolGrant } from "../shared/wire.ts";
import type { BrokerAccess } from "./composio-broker-access.ts";
import { managedComposioBrokerOff } from "./composio-broker-access.ts";
import { connectorProvider } from "./connectors/provider.ts";
import { normalizeAccountAlias, toolkitCategories } from "./connectors/common.ts";
import { CURATED, CURATED_SLUGS } from "./connectors/catalog.ts";
import {
  CONNECTOR_ALLOWED_TOOLS_ENV,
  CONNECTOR_ALLOWED_TOOLS_MAX_BYTES,
  CONNECTOR_SERVICE_SLUGS_ENV,
  CONNECTOR_SERVICE_SLUGS_MAX_BYTES,
  serializeConnectorAllowedTools,
  serializeConnectorServiceSlugs,
} from "./connector-advertisement.ts";
import { connectedAppGrantSlugs, serviceSlugFor, serviceSlugForCandidates } from "./connector-verdict.ts";
import type {
  CatalogPagination,
  ComposioMcpIntegration,
  ConnectedServicesInventory,
  ConnectorAvailability,
  ConnectorProvider,
  ConnectorServiceState,
  ConnectorSetup,
  ConnectorToolListing,
  JsonValue,
  ToolkitCard,
} from "./connectors/types.ts";
export { applyManagedBrokerMessage, brokerAccess, setManagedBrokerAccess, type BrokerAccess } from "./composio-broker-access.ts";
export { prepareProjectSession, trustedSessionMcpUrl } from "./composio-session.ts";
export { normalizeAccountAlias, toolkitCategories };
export { CURATED_SLUGS };
export type {
  CatalogPagination,
  CatalogStopReason,
  ComposioMcpIntegration,
  ConnectedAccountSummary,
  ConnectedServicesInventory,
  ConnectorAvailability,
  ConnectorAuthItem,
  ConnectorCatalog,
  ConnectorMode,
  ConnectorProvider,
  ConnectorRelayResult,
  ConnectorServiceState,
  ConnectorSetup,
  ConnectorToolListing,
  ToolkitCard,
} from "./connectors/types.ts";

function provider(): ConnectorProvider {
  return connectorProvider();
}

export function connectionMode(cfg: AppConfig): "managed" | "self-hosted" | "unavailable" {
  return provider().mode(cfg);
}

export function configured(cfg: AppConfig): boolean {
  return provider().isConfigured(cfg);
}

/** "unreadable": the desktop shell set OMB_CREDENTIAL_STORE=unavailable, so the UI keeps its list instead of wiping it. */
export function connectorAvailability(
  cfg: AppConfig,
  storeState: string | undefined = process.env.OMB_CREDENTIAL_STORE,
): ConnectorAvailability {
  if (configured(cfg)) return "configured";
  return storeState === "unavailable" ? "unreadable" : "unconfigured";
}

/** Only a host the managed service comes with (the desktop app, OMB_DESKTOP_PARENT=1, or a Cloud home) calls a missing one an outage. */
export function connectorSetup(
  cfg: AppConfig,
  managedHost: boolean = process.env.OMB_DESKTOP_PARENT === "1",
): ConnectorSetup {
  if (configured(cfg)) return "ready";
  return provider().id === "composio" && managedHost && !managedComposioBrokerOff() ? "service-unavailable" : "needs-setup";
}

export interface IntegrationContext {
  harnessUrl: string;
  commsToken: string;
  botId: string;
  threadId: string;
  connectorTools?: Record<string, ConnectorToolGrant>;
  /** A Team Cloud member's own installation, instead of this server's. */
  as?: BrokerAccess;
}

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
) {
  return provider().relayMcp(cfg, payload, transportSessionId, beforeSend, signal, as);
}

export async function connectedServicesInventory(cfg: AppConfig, as?: BrokerAccess): Promise<ConnectedServicesInventory> {
  return provider().inventory(cfg, as);
}

export async function verifiedConnectedServiceSlugs(cfg: AppConfig, as?: BrokerAccess): Promise<readonly string[]> {
  const { services, complete } = await connectedServicesInventory(cfg, as);
  if (!complete) throw new Error("Connected-app inventory is incomplete; account discovery did not finish.");
  return Object.keys(services);
}

export async function connectedServices(cfg: AppConfig, as?: BrokerAccess): Promise<Record<string, ConnectorServiceState>> {
  return provider().inventory(cfg, as).then((inventory) => inventory.services);
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
  if (!connected || !connectedAppGrantSlugs(grants).length) return null;
  const unconnected = connectedAppGrantSlugs(grants).filter((slug) => !connected[slug]?.connected);
  if (unconnected.length) {
    return `connectorTools names services that are not connected: ${unconnected.join(", ")}`;
  }
  const catalog = await listToolkits(cfg);
  if (catalog.source !== "api" || !catalog.pagination?.complete) return null;
  const known = new Set(catalog.cards.map((card) => card.slug.toLowerCase()));
  const unknown = connectedAppGrantSlugs(grants).filter((slug) => !known.has(slug));
  if (unknown.length) {
    return `connectorTools names services missing from the connected-apps catalog: ${unknown.join(", ")}`;
  }
  return null;
}

export async function listConnectorTools(
  cfg: AppConfig,
  options: { force?: boolean } = {},
): Promise<Record<string, ConnectorToolListing[]>> {
  return provider().tools(cfg, options.force);
}

export async function connectedServiceSlugs(cfg: AppConfig, as?: BrokerAccess): Promise<readonly string[]> {
  return provider().serviceSlugs(cfg, as);
}

export async function connectionStatus(cfg: AppConfig, slugs: string[]) {
  return provider().status(cfg, slugs);
}

export async function removeService(cfg: AppConfig, slug: string, as?: BrokerAccess) {
  return provider().removeService(cfg, slug, as);
}

export async function removeAccount(cfg: AppConfig, slug: string, accountId: string) {
  return provider().removeAccount(cfg, slug, accountId);
}

export async function prepareConnectionAuthConfigs(
  cfg: AppConfig,
  items: ReadonlyArray<{ slug: string; authConfigId?: string }>,
): Promise<string | undefined> {
  if (provider().id !== "composio" && items.some((item) => item.authConfigId)) {
    throw inputError("authConfigId is only supported by the Composio connector backend");
  }
  return provider().prepareAuthConfigs(cfg, items);
}

export async function authorizeService(cfg: AppConfig, slug: string, requestedAlias?: string | null, as?: BrokerAccess) {
  return provider().authorize(cfg, slug, requestedAlias, as);
}

export async function listToolkits(cfg: AppConfig): Promise<{ cards: ToolkitCard[]; source: "api" | "curated"; pagination?: CatalogPagination }> {
  return provider().catalog(cfg);
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
