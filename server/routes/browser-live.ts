// The live-browser owner routes — the watch stream and the viewer
// input/action POST on /api/bots/:id/browser/(live|action) — extracted
// verbatim from index.ts's dispatch chain, where the block sat immediately
// before the events-stream dispatch (which stays in index.ts, in the same
// relative order after this handler). Path matching, the profile/engine
// gates, the hosted-workspace re-auth after browser discovery, and every
// status code are unchanged; the handler returns false for anything it does
// not own so the chain falls through in the same order. The store, readBody,
// browser runtime handles, session registry and hosted flag are index-local
// and cross via deps; workspaceAccess is a let index.ts assigns during boot,
// so it crosses as a thunk resolved at call time.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, type readBody, type RouteContext } from "./http.ts";
import { cfg, type store } from "../runtime.ts";
import { builtInBrowserEnabled } from "../config.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { WorkspaceAccess } from "../enterprise.ts";
import type { createTurnIntegrations } from "../turn-integrations.ts";

type TurnIntegrations = ReturnType<typeof createTurnIntegrations>;

export interface BrowserLiveRoutesDeps {
  store: typeof store;
  readBody: typeof readBody;
  browserLive: TurnIntegrations["browserLive"];
  browserIntegration: TurnIntegrations["browserIntegration"];
  currentBrowserSession: TurnIntegrations["currentBrowserSession"];
  sessions: SessionRegistry;
  HOSTED_WORKSPACE: boolean;
  workspaceAccess(): WorkspaceAccess | null;
}

export function createBrowserLiveRoutes(deps: BrowserLiveRoutesDeps) {
  const {
    store,
    readBody,
    browserLive,
    browserIntegration,
    currentBrowserSession,
    sessions,
    HOSTED_WORKSPACE,
    workspaceAccess,
  } = deps;
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const match = /^\/api\/bots\/([\w-]+)\/browser\/(live|action)$/.exec(rctx.path);
    if (!match) return false;
    const { method, auth } = rctx;
    // ── events stream ──
    // Owner-only (default-deny in request-auth). Never mix login frames into
    // the general events feed, which is also visible to client-only devices.
    res.setHeader("cache-control", "no-store");
    const bot = store.bot(match[1]);
    if (!bot) {
      json(res, 404, { error: "no such bot" });
      return true;
    }
    if (!builtInBrowserEnabled(cfg) || bot.browser === false) {
      json(res, 409, { error: "Enable this bot's browser in its profile first." });
      return true;
    }
    const browser = await browserIntegration(bot.id, bot.browserProfile);
    if (!browser) {
      json(res, 503, { error: "Install the browser engine first." });
      return true;
    }
    // Browser discovery may have awaited while the portal became unavailable
    // and closed this owner's streams. Do not open a late replacement on
    // the earlier authorization; once registered, exact-owner close covers it.
    if (HOSTED_WORKSPACE && auth.kind === "session") {
      const access = workspaceAccess();
      const failure = access
        ? await access.authorize(req, auth)
        : { status: 503, error: "Workspace sign-in is unavailable." };
      if (failure) {
        json(res, failure.status, { error: failure.error });
        return true;
      }
    }
    const owner = auth.kind === "session" ? auth.session.id : "local-owner";
    const isCurrent = () => {
      const current = store.bot(bot.id);
      return !!current && current.browser !== false && builtInBrowserEnabled(cfg)
        && currentBrowserSession(current.id, current.browserProfile) === browser.session
        && (auth.kind !== "session" || sessions.isLive(auth.session.id));
    };
    if (method === "GET" && match[2] === "live") {
      req.socket.setTimeout(0);
      await browserLive.open({ botId: bot.id, session: browser.session, spec: browser.spec, owner, isCurrent, res });
      return true;
    }
    if (method === "POST" && match[2] === "action") {
      const body = await readBody(req, 32_768);
      if (!isCurrent()) {
        json(res, 409, { error: "This browser session changed. Reopen the browser panel." });
        return true;
      }
      if (typeof body?.viewerId !== "string") {
        json(res, 400, { error: "A live browser connection is required." });
        return true;
      }
      if (body.type === "restart" && store.bots.some((candidate) => candidate.busy &&
          currentBrowserSession(candidate.id, candidate.browserProfile) === browser.session)) {
        json(res, 409, { error: "Stop every bot using this profile before restarting its browser." });
        return true;
      }
      json(res, 200, await browserLive.action({ viewerId: body.viewerId, botId: bot.id, owner, body }));
      return true;
    }
    json(res, 405, { error: "method not allowed" });
    return true;
  };
}
