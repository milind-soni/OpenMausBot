// GET /api/connectors/catalog    the apps the Apps page lists
// GET /api/connectors/connected  which of them are connected
import type { AppConfig } from "../config.ts";
import type * as Composio from "../composio.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ConnectorListingDeps {
  cfg(): AppConfig;
  composio: Pick<typeof Composio, "listToolkits" | "configured" | "connectionMode" | "connectorSetup" | "connectorAvailability" | "sharedConnectedInventory">;
  /** Which host serves the catalog: "cloud-home" reports a missing service as an outage; "desktop" reports missing setup the person can add. */
  host: Composio.ConnectorSetupHost;
}

export function createConnectorListingRoutes(deps: ConnectorListingDeps): RouteHandler {
  const { composio } = deps;
  return async ({ req, res, path, method, json }) => {
    if (method !== "GET") return PASS;
    if (path === "/api/connectors/catalog") {
      const cfg = deps.cfg();
      const { cards, source, pagination } = await composio.listToolkits(cfg);
      return json(res, 200, {
        configured: composio.configured(cfg),
        mode: composio.connectionMode(cfg),
        setup: composio.connectorSetup(cfg, deps.host),
        source,
        cards,
        ...(pagination ? { pagination } : {}),
      });
    }
    if (path === "/api/connectors/connected") {
      const cfg = deps.cfg();
      const availability = composio.connectorAvailability(cfg);
      if (availability !== "configured") {
        return json(res, 200, {
          configured: false,
          credentialStore: availability === "unreadable" ? "unavailable" : "ok",
          services: {},
        });
      }
      // The page's Refresh asks with no-cache; every other reader shares one read.
      const inventory = await composio.sharedConnectedInventory(cfg, { fresh: req.headers["cache-control"] === "no-cache" });
      return json(res, 200, {
        configured: true,
        credentialStore: "ok",
        inventoryComplete: inventory.complete,
        services: inventory.services,
      });
    }
    return PASS;
  };
}
