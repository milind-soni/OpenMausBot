import { api } from "@/state/store";
import { unlessRefused } from "@/lib/admin-scope";
import { readCachedInventory, writeCachedInventory } from "@/lib/connected-apps-cache";
import type { ConnectorStatus } from "@/lib/connector-status";

// The connected-apps inventory and its 30 s memory cache. Its own module so the sidebar, the usage meter and a bot's apps
// can ask for it without loading the Apps panel.

let cachedConnectorStatus: Record<string, ConnectorStatus> | null = null;
let cachedConnectorStatusAt = 0;
let cachedConnectorStatusAuthoritative = true;
let connectorStatusRequest: Promise<ConnectorInventory> | null = null;
const CONNECTOR_STATUS_CACHE_MS = 30_000;

export interface ConnectorInventory {
  services: Record<string, ConnectorStatus>;
  /** false when the server could not read the credential store: nothing may be cleared on the strength of it. */
  authoritative: boolean;
  /** This session may not see the connected apps: its role, not the credential store. */
  refused?: true;
}

const REFUSED_INVENTORY: ConnectorInventory = { services: {}, authoritative: true, refused: true };

export function preloadConnectedApps(force = false, background = false): Promise<ConnectorInventory> { // background: src/state/api.ts
  if (!force && cachedConnectorStatus !== null && Date.now() - cachedConnectorStatusAt < CONNECTOR_STATUS_CACHE_MS) {
    return Promise.resolve({
      services: cachedConnectorStatus,
      authoritative: cachedConnectorStatusAuthoritative,
    });
  }
  if (connectorStatusRequest) return connectorStatusRequest;
  type ConnectedAnswer = { services?: Record<string, ConnectorStatus>; credentialStore?: string; inventoryComplete?: boolean };
  connectorStatusRequest = unlessRefused<ConnectedAnswer | null>("/api/connectors/connected", () => api("/api/connectors/connected", background ? { background: true } : undefined), null)
    .then((response): ConnectorInventory => {
      if (!response) return REFUSED_INVENTORY;
      const services: Record<string, ConnectorStatus> = response.services ?? {};
      if (response.credentialStore === "unavailable" || response.inventoryComplete === false) {
        cachedConnectorStatusAuthoritative = false;
        return { services: readCachedInventory()?.services ?? services, authoritative: false };
      }
      cachedConnectorStatus = services;
      cachedConnectorStatusAt = Date.now();
      cachedConnectorStatusAuthoritative = true;
      writeCachedInventory(services, Date.now());
      return { services, authoritative: true };
    })
    .catch(() => ({ services: readCachedInventory()?.services ?? {}, authoritative: false }))
    .finally(() => {
      connectorStatusRequest = null;
    });
  return connectorStatusRequest;
}

/** What the Apps panel starts from: the last answer this page holds, if any. */
export function connectorStatusMemory(): { services: Record<string, ConnectorStatus>; authoritative: boolean } | null {
  return cachedConnectorStatus === null ? null : { services: cachedConnectorStatus, authoritative: cachedConnectorStatusAuthoritative };
}

/** The Apps panel's own reads land here, so the next preload within 30 s reuses them. */
export function rememberConnectorStatus(services: Record<string, ConnectorStatus>, authoritative: boolean): void {
  cachedConnectorStatus = services;
  cachedConnectorStatusAt = Date.now();
  cachedConnectorStatusAuthoritative = authoritative;
}
