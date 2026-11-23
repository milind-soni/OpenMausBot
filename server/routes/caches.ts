// GET /api/caches: the cache cap's counters and its last sweep (cache-sweep/sweeper.ts). POST /api/caches/clear: clearCaches,
// for an operator now and the customer's "Clear cache" button later; a dry run unless the body says `"dryRun": false`. Both
// admin scope (request-auth's default), so a bot's shell never reaches them, and only with the cap's switch on, which is
// only ever on a Cloud home: off, they are not there at all.
import { CacheSweepOff, type CacheSweeper } from "../cache-sweep/sweeper.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const CACHES_PATH = "/api/caches";
export const CACHES_CLEAR_PATH = "/api/caches/clear";
const SCOPES = new Set(["tools", "app", "all"]);

export function createCachesRoutes(sweeper: Pick<CacheSweeper, "available" | "clearCaches" | "report">): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== CACHES_PATH && path !== CACHES_CLEAR_PATH) return PASS;
    if (!sweeper.available()) return PASS;
    if (method === "GET" && path === CACHES_PATH) {
      res.setHeader("cache-control", "no-store");
      return json(res, 200, await sweeper.report());
    }
    if (method !== "POST" || path !== CACHES_CLEAR_PATH) return PASS;
    res.setHeader("cache-control", "no-store");
    const body = await readBody(req, 4096).catch(() => null) as { dryRun?: unknown; scope?: unknown } | null;
    const scope = typeof body?.scope === "string" && SCOPES.has(body.scope) ? body.scope as "tools" | "app" | "all" : "all";
    try {
      return json(res, 200, await sweeper.clearCaches({ dryRun: body?.dryRun !== false, scope }));
    } catch (error) {
      if (error instanceof CacheSweepOff) return json(res, 409, { error: error.message });
      throw error;
    }
  };
}
