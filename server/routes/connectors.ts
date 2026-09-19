// The Composio connector HTTP routes, extracted verbatim from index.ts's
// dispatch chain. Path matching, methods, and status codes are unchanged;
// the handler returns false for anything it does not own so the chain falls
// through in the same order. Each route binds its own match const; the
// phone-credential secret-cards route that follows this family stays in
// index.ts.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { cfg } from "../runtime.ts";
import * as composio from "../composio.ts";

export function createConnectorRoutes() {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url } = rctx;
    // ── connectors (Composio) ──
    if (method === "GET" && path === "/api/connectors/catalog") {
      const { cards, source } = await composio.listToolkits(cfg);
      json(res, 200, { configured: composio.configured(cfg), mode: composio.connectionMode(cfg), source, cards });
      return true;
    }
    if (method === "GET" && path === "/api/connectors/connected") {
      const availability = composio.connectorAvailability(cfg);
      if (availability !== "configured") {
        // `credentialStore` is what stops the panel treating this empty list
        // as authoritative: an unreadable store means we do not KNOW what is
        // connected, which is not the same as knowing nothing is.
        json(res, 200, {
          configured: false,
          credentialStore: availability === "unreadable" ? "unavailable" : "ok",
          services: {},
        });
        return true;
      }
      json(res, 200, { configured: true, credentialStore: "ok", services: await composio.connectedServices(cfg) });
      return true;
    }
    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      const availability = composio.connectorAvailability(cfg);
      if (availability !== "configured") {
        json(res, 200, {
          configured: false,
          credentialStore: availability === "unreadable" ? "unavailable" : "ok",
          services: {},
        });
        return true;
      }
      const status = await composio.connectionStatus(cfg, services.length ? services : composio.CURATED_SLUGS);
      json(res, 200, { configured: true, services: status });
      return true;
    }
    const authorize = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (authorize && method === "POST") {
      const body = await readBody(req);
      json(res, 200, await composio.authorizeService(cfg, authorize[1], body.alias));
      return true;
    }
    const account = path.match(/^\/api\/connectors\/([\w-]+)\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
    if (account && method === "DELETE") {
      json(res, 200, await composio.removeAccount(cfg, account[1], account[2]));
      return true;
    }
    const service = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (service && method === "DELETE") {
      json(res, 200, await composio.removeService(cfg, service[1]));
      return true;
    }
    return false;
  };
}
