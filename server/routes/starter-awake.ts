// POST /api/starter/awake { awake: string[] } chooses which bots a Starter Cloud keeps awake past its limit. An admin's:
// request-auth.ts lists no client scope for it. What is paused now reaches the app with the config.
import type { StarterAwake } from "../host/starter-awake.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const STARTER_AWAKE_PATH = "/api/starter/awake";

export function createStarterAwakeRoutes({ awake }: { awake: StarterAwake }): RouteHandler {
  return async ({ req, res, method, path, json, readBody }) => {
    if (path !== STARTER_AWAKE_PATH) return PASS;
    if (method !== "POST") return json(res, 405, { error: "Use POST." });
    const body = await readBody(req);
    const ids = (body as { awake?: unknown } | null)?.awake;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return json(res, 400, { error: "awake must be a list of bot ids" });
    const chosen = awake.choose(ids as string[]);
    if (!chosen.ok) return json(res, 400, { error: chosen.error });
    return json(res, 200, { paused: awake.paused() });
  };
}
