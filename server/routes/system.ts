// The status and diagnostics tail (the authed /api/health identity
// handshake, the browser-engine install, /api/edition, the authed
// /api/brand, and the thread-events inspector), extracted verbatim from
// index.ts's dispatch chain. Path matching, methods, and status codes
// are unchanged; the handler returns false for anything it does not own
// so the chain falls through in the same order. The fleet proxy block
// used to sit between the install and edition handlers and stays in
// index.ts; its /api/fleet regex is disjoint from every path owned here,
// so it now matching after this module's call site changes nothing for
// any request. The install promise and error lets stay in index.ts (the
// maintenance idle gate and the config summary read them there) and
// cross as get/set pairs; the pre-auth !gate.auth /api/health and
// /api/brand probes stay in index.ts; store is a live binding from
// ../runtime.ts.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, type RouteContext } from "./http.ts";
import { store } from "../runtime.ts";
import {
  browserEngineStatus,
  ensureChrome,
  installAgentBrowserBinary,
  resolveAgentBrowserBinary,
} from "../browser-engine.ts";
import { editionStatus } from "../enterprise.ts";
import { loadBrand } from "../brand.ts";
import { readThreadEvents } from "../thread-events.ts";
import { EVENTS_DIR, NATIVE_DIR } from "../config.ts";
import type { createEventsRoutes } from "./events.ts";
import type { createConfigViews } from "../config-views.ts";

export function createSystemRoutes(deps: {
  STATIC_DIR: string | null;
  browserEngineInstall: { get: () => Promise<void> | null; set: (value: Promise<void> | null) => void };
  browserEngineInstallError: { get: () => string | null; set: (value: string | null) => void };
  broadcast: ReturnType<typeof createEventsRoutes>["broadcast"];
  configStatus: ReturnType<typeof createConfigViews>["configStatus"];
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url } = rctx;
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    const {
      STATIC_DIR,
      browserEngineInstall,
      browserEngineInstallError,
      broadcast,
      configStatus,
    } = deps;
    // identity handshake for the packaged app's port fallback: the forked
    // child proves it is OURS by echoing its pid (a stray dev server has
    // the same API shape but a different pid)
    if (method === "GET" && path === "/api/health") {
      json(res, 200, { app: "openmausbot", pid: process.pid, static: Boolean(STATIC_DIR) });
      return true;
    }
    // The bots' browser engine: install it on this machine (agent-browser +
    // a Chrome for Testing, a one-time download), or ask how that is going.
    // One install at a time; the config frame's browserEngine tells the rest.
    if (method === "POST" && path === "/api/browser-engine/install") {
      // A page served from another loopback origin can fire a simple form
      // POST at this route; requiring JSON makes the request non-simple, so
      // the browser must preflight and the loopback origin policy applies
      // before any download is triggered.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      if (!browserEngineInstall.get()) {
        const status = browserEngineStatus();
        if (status.kind === "unavailable" && !status.installable) {
          json(res, 409, { error: status.reason });
          return true;
        }
        browserEngineInstallError.set(null);
        browserEngineInstall.set((async () => {
          const binary = resolveAgentBrowserBinary() ?? await installAgentBrowserBinary({ log: (line) => console.log(line) });
          await ensureChrome(binary, { log: (line) => console.log(line) });
        })().then(
          () => { browserEngineInstallError.set(null); },
          (error: unknown) => { browserEngineInstallError.set(error instanceof Error ? error.message : String(error)); },
        ).finally(() => {
          browserEngineInstall.set(null);
          broadcast({ kind: "config", ...configStatus() });
        }));
        broadcast({ kind: "config", ...configStatus() });
      }
      json(res, 202, { installing: true });
      return true;
    }

    // Which edition this server runs and why (see server/enterprise.ts). Read-only.
    if (method === "GET" && path === "/api/edition") {
      json(res, 200, editionStatus());
      return true;
    }
    // The brand for this deployment (server/brand.ts): read per request so edits show on reload.
    if (method === "GET" && path === "/api/brand") {
      json(res, 200, loadBrand());
      return true;
    }

    // ── inspector: a thread's runtime events + native protocol tee ──
    // Both logs already exist on disk; this only reads them back. Threads
    // belong to bots or rooms — anything else is not a thread we know.
    m = path.match(/^\/api\/threads\/([\w-]+)\/events$/);
    if (m && method === "GET") {
      const threadId = m[1];
      const known =
        store.bots.some((b) => store.tasks(b.id).some((t) => t.threadId === threadId)) ||
        Boolean(store.groupByThread(threadId));
      if (!known) {
        json(res, 404, { error: "no such thread" });
        return true;
      }
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        json(res, 400, { error: "limit must be a positive whole number" });
        return true;
      }
      const limit = parsedLimit;
      json(res, 200, readThreadEvents({ eventsDir: EVENTS_DIR, nativeDir: NATIVE_DIR, threadId, limit }));
      return true;
    }
    return false;
  };
}
