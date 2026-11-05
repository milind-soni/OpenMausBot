// The Apps card's OpenConnector routes, for the owner or an admin (request-auth.ts leaves every one off a client's list):
//   GET    /api/openconnector          the connection: where it runs and whether OpenMausBot runs it; never a secret
//   POST   /api/openconnector/connect  ensure the process (when managed) and turn the `openconnector` server on
//   POST   /api/openconnector/check    the saved connection checked again (a stopped process is restarted)
//   DELETE /api/openconnector          the server removed and the managed process stopped
// The card saves its settings through /api/config (validated by the service's configCheck) before it connects.
import type { OpenConnector } from "../openconnector/service.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface OpenConnectorRouteDeps {
  openconnector: OpenConnector;
}

export function createOpenConnectorRoutes(deps: OpenConnectorRouteDeps): RouteHandler {
  const { openconnector } = deps;
  return async ({ res, path, method, auth, json }) => {
    if (path !== "/api/openconnector" && !path.startsWith("/api/openconnector/")) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only the owner or an admin can manage the OpenConnector connection." });
    res.setHeader("Cache-Control", "no-store");
    if (path === "/api/openconnector") {
      if (method === "GET") return json(res, 200, openconnector.status());
      if (method !== "DELETE") return json(res, 405, { error: "method not allowed" });
      const done = await openconnector.disconnect();
      return done.ok ? json(res, 200, done.status) : json(res, done.status, { error: done.error, code: done.code });
    }
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (path === "/api/openconnector/connect") {
      const done = await openconnector.connect();
      return done.ok ? json(res, 200, done.status) : json(res, done.status, { error: done.error, code: done.code });
    }
    if (path === "/api/openconnector/check") {
      return json(res, 200, await openconnector.check());
    }
    return json(res, 404, { error: "not found" });
  };
}
