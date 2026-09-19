// The custom MCP server HTTP routes (a local command or a URL; secrets
// write-only), extracted verbatim from index.ts's dispatch chain. Path
// matching, methods, and status codes are unchanged; the handler returns
// false for anything it does not own so the chain falls through in the same
// order. The single-flight flag and the probe semaphore moved with the
// family: nothing else in index.ts reads them. The config views that render
// and persist the server list cross through deps.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { cfg } from "../runtime.ts";
import {
  MAX_MCP_SERVERS,
  parseMcpServerMutation,
  parseMcpServersImport,
  parseStoredMcpServer,
} from "../mcp-registry.ts";
import { probeMcpServer } from "../mcp-probe.ts";
import { type createConfigViews } from "../config-views.ts";
import type { SessionRegistry } from "../sessions.ts";

let mcpConfigBusy = false;
const MAX_CONCURRENT_MCP_PROBES = 2;
let mcpProbesInFlight = 0;

export function createMcpRoutes(deps: {
  sessions: SessionRegistry;
  mcpServerResponse: ReturnType<typeof createConfigViews>["mcpServerResponse"];
  mcpServerBody: ReturnType<typeof createConfigViews>["mcpServerBody"];
  persistMcpServers: ReturnType<typeof createConfigViews>["persistMcpServers"];
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, auth } = rctx;
    const { sessions, mcpServerResponse, mcpServerBody, persistMcpServers } = deps;
    // ── custom MCP servers (a local command or a URL; secrets write-only) ──
    if (method === "GET" && path === "/api/mcp/servers") {
      json(res, 200, mcpServerResponse());
      return true;
    }

    const mcpTest = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})\/test$/.exec(path);
    if (method === "POST" && mcpTest) {
      const raw = cfg.mcpServers?.[mcpTest[1]];
      if (raw === undefined) {
        json(res, 404, { error: "MCP server not found." });
        return true;
      }
      const parsed = parseStoredMcpServer(mcpTest[1], raw);
      if (!parsed.ok) {
        json(res, 400, { error: parsed.error });
        return true;
      }
      if (mcpProbesInFlight >= MAX_CONCURRENT_MCP_PROBES) {
        json(res, 429, { error: "Two MCP connection tests are already running." });
        return true;
      }
      const controller = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", disconnect);
      mcpProbesInFlight += 1;
      try {
        json(res, 200, await probeMcpServer(parsed.server, undefined, controller.signal));
        return true;
      } finally {
        res.off("close", disconnect);
        mcpProbesInFlight -= 1;
      }
    }

    if (method === "POST" && path === "/api/mcp/servers") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      if (mcpConfigBusy) {
        json(res, 409, { error: "MCP servers are already being updated." });
        return true;
      }
      mcpConfigBusy = true;
      try {
        const body = await readBody(req);
        const name = typeof body?.name === "string" ? body.name : "";
        const current = cfg.mcpServers ?? {};
        if (Object.hasOwn(current, name)) {
          json(res, 409, { error: "An MCP server with that name already exists." });
          return true;
        }
        if (Object.keys(current).length >= MAX_MCP_SERVERS) {
          json(res, 400, { error: `You can add at most ${MAX_MCP_SERVERS} MCP servers.` });
          return true;
        }
        const parsed = parseMcpServerMutation(name, mcpServerBody(body));
        if (!parsed.ok) {
          json(res, 400, { error: parsed.error });
          return true;
        }
        persistMcpServers({ ...current, [name]: parsed.server });
        json(res, 201, mcpServerResponse());
        return true;
      } finally {
        mcpConfigBusy = false;
      }
    }

    // Paste-to-add: the {"mcpServers": {...}} block every other agent tool
    // writes. Same rules as POST: disabled until explicitly enabled.
    if (method === "POST" && path === "/api/mcp/servers/import") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      if (mcpConfigBusy) {
        json(res, 409, { error: "MCP servers are already being updated." });
        return true;
      }
      mcpConfigBusy = true;
      try {
        const body = await readBody(req);
        const text = typeof body?.json === "string" ? body.json : "";
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
          return true;
        }
        if (!text.trim()) {
          json(res, 400, { error: "Paste the JSON block first." });
          return true;
        }
        const parsed = parseMcpServersImport(text);
        if (!parsed.ok) {
          json(res, 400, { error: parsed.error });
          return true;
        }
        const current = cfg.mcpServers ?? {};
        const names = Object.keys(parsed.servers);
        const taken = names.filter((name) => Object.hasOwn(current, name));
        if (taken.length) {
          json(res, 409, { error: `Already added: ${taken.join(", ")}. Remove or rename ${taken.length === 1 ? "it" : "them"} first.` });
          return true;
        }
        if (Object.keys(current).length + names.length > MAX_MCP_SERVERS) {
          json(res, 400, { error: `You can add at most ${MAX_MCP_SERVERS} MCP servers.` });
          return true;
        }
        persistMcpServers({ ...current, ...parsed.servers });
        json(res, 201, { ...mcpServerResponse(), added: names });
        return true;
      } finally {
        mcpConfigBusy = false;
      }
    }

    const mcpServerRoute = /^\/api\/mcp\/servers\/([a-z][a-z0-9_-]{0,31})$/.exec(path);
    if (mcpServerRoute && ["PUT", "PATCH", "DELETE"].includes(method)) {
      if (method !== "DELETE" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      if (mcpConfigBusy) {
        json(res, 409, { error: "MCP servers are already being updated." });
        return true;
      }
      mcpConfigBusy = true;
      try {
        const name = mcpServerRoute[1];
        const current = cfg.mcpServers ?? {};
        if (!Object.hasOwn(current, name)) {
          json(res, 404, { error: "MCP server not found." });
          return true;
        }
        if (method === "DELETE") {
          const next = { ...current };
          delete next[name];
          persistMcpServers(next);
          json(res, 200, mcpServerResponse());
          return true;
        }

        const existing = parseStoredMcpServer(name, current[name]);
        if (!existing.ok) {
          json(res, 400, { error: existing.error });
          return true;
        }
        const body = await readBody(req);
        if (method === "PATCH") {
          if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") {
            json(res, 400, { error: "Only an enabled boolean can be changed here." });
            return true;
          }
          persistMcpServers({ ...current, [name]: { ...existing.server, enabled: body.enabled } });
          json(res, 200, mcpServerResponse());
          return true;
        }

        const parsed = parseMcpServerMutation(name, body, existing.server);
        if (!parsed.ok) {
          json(res, 400, { error: parsed.error });
          return true;
        }
        persistMcpServers({ ...current, [name]: parsed.server });
        json(res, 200, mcpServerResponse());
        return true;
      } finally {
        mcpConfigBusy = false;
      }
    }
    return false;
  };
}
