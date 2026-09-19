// The fleet proxy routes — /api/fleet and its workspaces/upgrade subtree —
// extracted verbatim from index.ts's dispatch chain, where the block sat
// between the system routes and the usage routes. The admin entitlement
// gate, the fleet-socket availability probe, the method mapping onto the
// root agent's unix socket, and every status code are unchanged; the
// handler returns false for anything it does not own so the chain falls
// through in the same order. The entitlement check, the fleet socket
// helpers, and readBody cross via deps like the other route modules'
// index-local collaborators.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, type readBody, type RouteContext } from "./http.ts";
import type { entitled } from "../enterprise.ts";
import type { fleetAvailable, fleetRequest, fleetSocketPath } from "../fleet-client.ts";

export interface FleetRoutesDeps {
  entitled: typeof entitled;
  fleetSocketPath: typeof fleetSocketPath;
  fleetAvailable: typeof fleetAvailable;
  fleetRequest: typeof fleetRequest;
  readBody: typeof readBody;
}

export function createFleetRoutes(deps: FleetRoutesDeps) {
  const { entitled, fleetSocketPath, fleetAvailable, fleetRequest, readBody } = deps;
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const fleetRoute = /^\/api\/fleet(?:\/(workspaces(?:\/([a-z0-9-]+)(?:\/(users|suspend|resume))?)?|upgrade))?$/.exec(rctx.path);
    if (!fleetRoute) return false;
    const { method } = rctx;
    // ── the fleet: client workspaces on this server, through the root agent ──
    // Admin scope by default plus the `admin` entitlement; the socket's own
    // permissions decide whether this workspace may drive the agent at all.
    if (!entitled("admin")) {
      json(res, 403, { error: "Workspaces need an enterprise licence with the admin feature." });
      return true;
    }
    const socket = fleetSocketPath();
    if (!fleetAvailable(socket)) {
      json(res, 404, { error: "No fleet agent on this server. Run `openmausbot fleet init --domain … --operator <this user>` as root." });
      return true;
    }
    const [, resource, slug, sub] = fleetRoute;
    let forward: { method: string; path: string; body?: unknown } | null = null;
    if (method === "GET" && !resource) forward = { method: "GET", path: "/workspaces" };
    else if (method === "POST" && resource === "workspaces") forward = { method: "POST", path: "/workspaces", body: await readBody(req, 256 * 1024) };
    else if (method === "POST" && resource === "upgrade") forward = { method: "POST", path: "/upgrade" };
    else if (slug && method === "POST" && (sub === "users" || sub === "suspend" || sub === "resume")) forward = { method: "POST", path: `/workspaces/${slug}/${sub}`, ...(sub === "users" ? { body: await readBody(req, 8192) } : {}) };
    else if (slug && method === "DELETE" && !sub) forward = { method: "DELETE", path: `/workspaces/${slug}`, body: await readBody(req, 8192) };
    if (!forward) {
      json(res, 405, { error: "no such fleet operation" });
      return true;
    }
    res.setHeader("cache-control", "no-store");
    try {
      const reply = await fleetRequest(socket, forward.method, forward.path, forward.body);
      json(res, reply.status, reply.body ?? {});
      return true;
    } catch (error) {
      json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  };
}
