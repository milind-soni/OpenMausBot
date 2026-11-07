// The seam the connected-apps layer runs on: one provider behind server/composio.ts, so a host
// picks a backend in config without its callers or the bots' tool surface changing shape.
import type { AppConfig } from "../config.ts";
import type { BrokerAccess } from "../composio-broker-access.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ConnectorMode = "managed" | "self-hosted" | "unavailable";
export type ConnectorAvailability = "configured" | "unconfigured" | "unreadable";
export type ConnectorSetup = "ready" | "needs-setup" | "service-unavailable";

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

export interface ConnectedServicesInventory {
  services: Record<string, ConnectorServiceState>;
  complete: boolean;
}

export interface ConnectorToolListing {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** The local MCP-proxy spawn a bot's engine runs to reach connector tools; the same bridge serves every provider. */
export interface ComposioMcpIntegration {
  command: string;
  args: string[];
  env: Record<string, string>;
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

export interface ConnectorCatalog {
  cards: ToolkitCard[];
  source: "api" | "curated";
  pagination?: CatalogPagination;
}

export interface ConnectorRelayResult {
  status: number;
  bytes: Uint8Array;
  contentType: string;
  transportSessionId?: string;
}

export interface ConnectorAuthItem {
  slug: string;
  authConfigId?: string;
}

/** Every capability server/composio.ts exposes, behind one switchable backend. `as` is a Team Cloud
 * member's own installation and stays a Composio-broker concept; other providers ignore it. */
export interface ConnectorProvider {
  readonly id: "composio" | "openconnector";
  mode(cfg: AppConfig): ConnectorMode;
  isConfigured(cfg: AppConfig): boolean;
  inventory(cfg: AppConfig, as?: BrokerAccess): Promise<ConnectedServicesInventory>;
  tools(cfg: AppConfig, force?: boolean): Promise<Record<string, ConnectorToolListing[]>>;
  serviceSlugs(cfg: AppConfig, as?: BrokerAccess): Promise<readonly string[]>;
  status(cfg: AppConfig, slugs: string[], as?: BrokerAccess): Promise<Record<string, ConnectorServiceState>>;
  removeService(cfg: AppConfig, slug: string, as?: BrokerAccess): Promise<{ removed: number }>;
  removeAccount(cfg: AppConfig, slug: string, accountId: string): Promise<{ removed: number }>;
  prepareAuthConfigs(cfg: AppConfig, items: ReadonlyArray<ConnectorAuthItem>): Promise<string | undefined>;
  authorize(cfg: AppConfig, slug: string, requestedAlias?: string | null, as?: BrokerAccess): Promise<{ url: string; connectionRequestId?: string }>;
  catalog(cfg: AppConfig): Promise<ConnectorCatalog>;
  relayMcp(
    cfg: AppConfig,
    payload: JsonValue,
    transportSessionId?: string,
    beforeSend?: () => void,
    signal?: AbortSignal,
    as?: BrokerAccess,
  ): Promise<ConnectorRelayResult>;
  dispose?(): void;
}
