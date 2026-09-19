// The HTTP request handler — extracted verbatim from index.ts's
// handleRequest: URL parsing, the pre-auth dispatch head, the auth gate
// with its sliding cookie re-issue, the public /api/health and /api/brand
// probes, the hosted-workspace access check, the backup-session request
// accounting, and the full route dispatch chain down to the 404 reply.
// index.ts calls createRequestHandler exactly where the const sat and
// hands the result to createServer and runBootSequence unchanged. The
// per-request RouteContext declaration and every comment inside the body
// move verbatim. The route handlers, the gate/cookie helpers, sessions,
// the mutation-token lets and workspaceAccess (read here at request
// time, so they cross as thunks), and the workspace-maintenance and
// team-computer state cross via deps.
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouteContext } from "./routes/http.ts";
import type { resolveRequestAuth, parseCookies, serializeSessionCookie, requestOrigin } from "./request-auth.ts";
import type { SessionRegistry, cookieMaxAgeSeconds } from "./sessions.ts";
import type { loadBrand } from "./brand.ts";
import type { json } from "./http.ts";
import type { sharedComputersEnabled } from "./config.ts";
import type { cfg, workspaceMaintenance } from "./runtime.ts";
import type { isWorkspaceBackupSessionControl } from "./workspace-backup-http.ts";
import type { WorkspaceAccess } from "./enterprise.ts";
import type { createRouteHandlers } from "./route-wiring.ts";
import type { createEventsPipeline } from "./events-pipeline.ts";
import type { createComputerLifecycleWiring } from "./computer-lifecycle-wiring.ts";

type RouteHandlers = ReturnType<typeof createRouteHandlers>;
type EventsPipeline = ReturnType<typeof createEventsPipeline>;
type ComputerLifecycleWiring = ReturnType<typeof createComputerLifecycleWiring>;

/** Everything the request handler reads from its host: the route handlers
 * and helpers cross by value; the mutation-token lets and workspaceAccess
 * are index.ts state read at request time, so they cross as thunks. */
export interface RequestHandlerDeps {
  PORT: number;
  resolveRequestAuth: typeof resolveRequestAuth;
  sessions: SessionRegistry;
  SESSION_COOKIE: string;
  desktopMutationToken(): string | undefined;
  companionMutationToken(): string | undefined;
  sharedComputersEnabled: typeof sharedComputersEnabled;
  cfg: typeof cfg;
  parseCookies: typeof parseCookies;
  HOSTED_WORKSPACE: boolean;
  requestOrigin: typeof requestOrigin;
  serializeSessionCookie: typeof serializeSessionCookie;
  cookieMaxAgeSeconds: typeof cookieMaxAgeSeconds;
  json: typeof json;
  loadBrand: typeof loadBrand;
  workspaceAccess(): WorkspaceAccess | null;
  teamComputers: ComputerLifecycleWiring["teamComputers"];
  workspaceBackupRoutes: RouteHandlers["workspaceBackupRoutes"];
  workspaceMaintenance: typeof workspaceMaintenance;
  isWorkspaceBackupSessionControl: typeof isWorkspaceBackupSessionControl;
  eventsRoutes: EventsPipeline["eventsRoutes"];
  routinesRoutes: RouteHandlers["routinesRoutes"];
  internalRoutes: RouteHandlers["internalRoutes"];
  handleCalendarCalls: RouteHandlers["handleCalendarCalls"];
  handleMessages: RouteHandlers["handleMessages"];
  handleInstances: RouteHandlers["handleInstances"];
  handleMcp: RouteHandlers["handleMcp"];
  handleUsage: RouteHandlers["handleUsage"];
  handleConfig: RouteHandlers["handleConfig"];
  handleTts: RouteHandlers["handleTts"];
  handleConnectors: RouteHandlers["handleConnectors"];
  handleWebhooks: RouteHandlers["handleWebhooks"];
  handleTeams: RouteHandlers["handleTeams"];
  handleBots: RouteHandlers["handleBots"];
  handleBotManagement: RouteHandlers["handleBotManagement"];
  handleBotThreadOps: RouteHandlers["handleBotThreadOps"];
  handleBotTasks: RouteHandlers["handleBotTasks"];
  handleBotProfile: RouteHandlers["handleBotProfile"];
  handleBotMemory: RouteHandlers["handleBotMemory"];
  handlePreAuth: RouteHandlers["handlePreAuth"];
  handleAuthSession: RouteHandlers["handleAuthSession"];
  handleWorkspaceComms: RouteHandlers["handleWorkspaceComms"];
  handleComputers: RouteHandlers["handleComputers"];
  handleBotCards: RouteHandlers["handleBotCards"];
  handleBotComputer: RouteHandlers["handleBotComputer"];
  handleSystem: RouteHandlers["handleSystem"];
  handleBrowserLive: RouteHandlers["handleBrowserLive"];
  handleFleet: RouteHandlers["handleFleet"];
  handleNotify: RouteHandlers["handleNotify"];
}

export function createRequestHandler(deps: RequestHandlerDeps) {
  const {
  PORT, resolveRequestAuth, sessions, SESSION_COOKIE,
  desktopMutationToken, companionMutationToken, sharedComputersEnabled, cfg,
  parseCookies, HOSTED_WORKSPACE, requestOrigin, serializeSessionCookie,
  cookieMaxAgeSeconds, json, loadBrand, workspaceAccess,
  teamComputers, workspaceBackupRoutes, workspaceMaintenance, isWorkspaceBackupSessionControl,
  eventsRoutes, routinesRoutes, internalRoutes, handleCalendarCalls,
  handleMessages, handleInstances, handleMcp, handleUsage,
  handleConfig, handleTts, handleConnectors, handleWebhooks,
  handleTeams, handleBots, handleBotManagement, handleBotThreadOps,
  handleBotTasks, handleBotProfile, handleBotMemory, handlePreAuth,
  handleAuthSession, handleWorkspaceComms, handleComputers, handleBotCards,
  handleBotComputer, handleSystem, handleBrowserLive, handleFleet, handleNotify,
  } = deps;

  return async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  } catch {
    return json(res, 400, { error: "invalid request URL" });
  }
  const path = url.pathname;
  const method = req.method ?? "GET";
  let releaseWorkspaceRequest: (() => void) | undefined;
  try {
    if (await handlePreAuth(req, res, { method, path, url })) return;
    const gate = resolveRequestAuth(req, {
      sessions,
      cookieName: SESSION_COOKIE,
      streamPath: "/api/events",
      url,
      loopbackMutationToken: desktopMutationToken(),
      companionMutationToken: companionMutationToken(),
      features: { sharedComputers: sharedComputersEnabled(cfg) },
    });
    // The browser's cookie carries the term it was set with, and the
    // session's term slides on use (sessions.ts `renew`), so re-issue the
    // cookie on every cookie-authenticated request. One small header; and
    // unlike "send once per renewal" it survives a lost response and a
    // restart. Later handlers that clear the cookie (logout, self-revoke)
    // overwrite this header, which is the order we want.
    if (gate.auth?.kind === "session" && gate.auth.via === "cookie") {
      const presented = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
      if (presented) {
        const secure = HOSTED_WORKSPACE || requestOrigin(req)?.startsWith("https://") === true;
        res.setHeader("set-cookie", serializeSessionCookie(SESSION_COOKIE, presented, { secure, maxAgeSeconds: cookieMaxAgeSeconds(gate.auth.session) }));
      }
    }
    // Reachability probe, public: the phone races it across a server's
    // addresses before it has a session, and the tunnel verifier polls it.
    // A stranger learns only the app name; pid (the desktop boot probe keys
    // on it) and the static flag stay behind the gate below.
    if (method === "GET" && path === "/api/health" && !gate.auth) {
      return json(res, 200, { app: "openmausbot" });
    }
    // The brand is public too: the sign-in page must carry the deployment's
    // name and icon before anyone has a session, and it holds nothing secret.
    if (method === "GET" && path === "/api/brand" && !gate.auth) {
      return json(res, 200, loadBrand());
    }
    if (!gate.auth) return json(res, gate.status, { error: gate.error });
    const auth = gate.auth;
    /** per-request values shared by the route modules extracted below */
    const rctx: RouteContext = { method, path, url, auth };
    if (HOSTED_WORKSPACE && auth.kind === "session") {
      const access = workspaceAccess();
      const failure = access
        ? await access.authorize(req, auth)
        : { status: 503, error: "Workspace sign-in is unavailable." };
      if (failure) return json(res, failure.status, { error: failure.error });
    }

    if (method === "POST" && path === "/api/workspace-backup/restore" && teamComputers.list().some(computer => computer.section !== null)) {
      return json(res, 409, { error: "Unassign team computers before restoring a workspace; restored team names must not gain access to existing desktops" });
    }
    if (await workspaceBackupRoutes(req, res, path, auth)) return;
    // Count ordinary requests until their asynchronous handler returns, not
    // merely until the browser disconnects. A cancelled upload can still write.
    if (path.startsWith("/api/") && path !== "/api/events" && path !== "/api/health" && !path.startsWith("/api/shared-computers/") && !isWorkspaceBackupSessionControl(method, path)) {
      releaseWorkspaceRequest = workspaceMaintenance.request();
    }

    if (await handleAuthSession(req, res, rctx)) return;
    if (await handleWorkspaceComms(req, res, rctx)) return;
    // ── internal peer-agent comms (localhost + bot capability only) ───
    // The agents-proxy (spawned inside a bot's agent process) calls these to
    // discover peers and hand a message to one. Not part of the public API.
    if (await internalRoutes(req, res, path, method, url)) return;

    // ── routines calendar ────────────────────────────────────────────────
    if (await routinesRoutes(req, res, path, method, url)) return;

    // ── scheduled room sessions ────────────────────────────────────────
    if (await handleCalendarCalls(req, res, rctx)) return;

    // ── independent webhook triggers ────────────────────────────────────
    // Management stays on the app-only server. Actual deliveries land on a
    // second, webhook-only loopback listener so Funnel or a future hosted
    // relay never has to expose the rest of OpenMausBot's control surface.
    if (await handleWebhooks(req, res, rctx)) return;

    if (await handleBrowserLive(req, res, rctx)) return;
    if (eventsRoutes.handle(req, res, path, method, url, auth)) return;

    // ── bots ──
    // Paired sessions are authenticated above. The companion marker may
    // only narrow behavior (including its capability-free local dev proxy);
    // it never grants authority or replaces the existing request gate.
    if (await handleMessages(req, res, rctx)) return;

    if (await handleTeams(req, res, rctx)) return;
    if (await handleBots(req, res, rctx)) return;
    if (await handleBotManagement(req, res, rctx)) return;

    if (await handleBotProfile(req, res, rctx)) return;

    if (await handleBotMemory(req, res, rctx)) return;

    if (await handleBotThreadOps(req, res, rctx)) return;

    if (await handleBotTasks(req, res, rctx)) return;

    if (await handleComputers(req, res, rctx)) return;

    if (await handleSystem(req, res, rctx)) return;

    if (await handleFleet(req, res, rctx)) return;

    if (await handleNotify(req, res, rctx)) return;

    if (await handleUsage(req, res, rctx)) return;

    if (await handleInstances(req, res, rctx)) return;

    if (await handleMcp(req, res, rctx)) return;

    if (await handleConfig(req, res, rctx)) return;

    if (await handleTts(req, res, rctx)) return;

    if (await handleConnectors(req, res, rctx)) return;

    if (await handleBotCards(req, res, rctx)) return;

    if (await handleBotComputer(req, res, rctx)) return;

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    const status = (e as any)?.status ?? 500;
    return json(res, status, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    releaseWorkspaceRequest?.();
  }
  };
}
