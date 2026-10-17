import { routineVisible, type VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import { todayReport, type TodaySources } from "../today.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TodayRouteDeps {
  sources: () => TodaySources;
  visibleFor: (auth: RequestAuth) => VisibleSet;
  now?: () => number;
}

/** GET /api/today?since=<epoch ms>: `since` is the viewer's local midnight, or the start of a longer window. */
export function createTodayRoutes(deps: TodayRouteDeps): RouteHandler {
  return async ({ res, path, method, url, auth, json }) => {
    if (path !== "/api/today") return PASS;
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    const since = Number(url.searchParams.get("since") ?? Number.NaN);
    if (!Number.isFinite(since)) return json(res, 400, { error: "since must be a time in milliseconds" });
    const visible = deps.visibleFor(auth);
    return json(res, 200, todayReport(deps.sources(), {
      admin: auth.scopes.includes("admin"),
      thread: (threadId) => visible.thread(threadId),
      routine: (run) => routineVisible(run, visible),
    }, since, deps.now?.() ?? Date.now()));
  };
}
