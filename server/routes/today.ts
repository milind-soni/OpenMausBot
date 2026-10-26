import { routineVisible, type VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import { needsYouNow, todayReport, type TodaySources, type TodayViewer } from "../today.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TodayRouteDeps {
  sources: () => TodaySources;
  visibleFor: (auth: RequestAuth) => VisibleSet;
  /** A Team Cloud: whether an ask in this conversation is this session's person's. */
  asks?: (auth: RequestAuth, botId: string | undefined, threadId: string) => boolean;
  now?: () => number;
}

/** GET /api/today?since=<epoch ms>: `since` is the viewer's local midnight, or the start of a longer window.
 * GET /api/needs-you: only what needs this person now. */
export function createTodayRoutes(deps: TodayRouteDeps): RouteHandler {
  const viewerFor = (auth: RequestAuth): TodayViewer => {
    const visible = deps.visibleFor(auth);
    const asks = deps.asks;
    return {
      admin: auth.scopes.includes("admin"),
      thread: (threadId) => visible.thread(threadId),
      routine: (run) => routineVisible(run, visible),
      ...(asks ? { asks: (botId: string | undefined, threadId: string) => asks(auth, botId, threadId) } : {}),
    };
  };
  return async ({ res, path, method, url, auth, json }) => {
    if (path === "/api/needs-you") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      return json(res, 200, { items: needsYouNow(deps.sources(), viewerFor(auth), deps.now?.() ?? Date.now()) });
    }
    if (path !== "/api/today") return PASS;
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    const since = Number(url.searchParams.get("since") ?? Number.NaN);
    if (!Number.isFinite(since)) return json(res, 400, { error: "since must be a time in milliseconds" });
    return json(res, 200, todayReport(deps.sources(), viewerFor(auth), since, deps.now?.() ?? Date.now()));
  };
}
