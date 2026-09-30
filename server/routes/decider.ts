// POST /api/decider/test: Settings → Decision model's Test button. One tiny
// yes/no call with the draft key in the body, or the saved key, whatever the
// switches say, because it tests the key itself. The answer is a verdict
// (and how long it took), never the key and never the vendor's raw body.
// Admin-scoped by default (server/request-auth.ts lists no client rule for
// it): it spends a real, if tiny, amount on the workspace's key.
import type { Decider } from "../decider/index.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface DeciderRouteDeps {
  decider: Pick<Decider, "testKey">;
}

const MAX_KEY_LENGTH = 512;

export function createDeciderRoutes(deps: DeciderRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== "/api/decider/test" || method !== "POST") return PASS;
    const body = await readBody(req, 8192);
    if (body?.key !== undefined && typeof body.key !== "string") return json(res, 400, { error: "key must be a string" });
    const draft = typeof body?.key === "string" ? body.key.trim() : "";
    if (draft.length > MAX_KEY_LENGTH) return json(res, 400, { error: "That does not look like an API key." });
    res.setHeader("cache-control", "no-store");
    const result = await deps.decider.testKey(draft ? { key: draft } : {});
    if (result.ok) return json(res, 200, { ok: true, latencyMs: result.latencyMs });
    return json(res, 200, { ok: false, reason: result.reason, ...(result.status ? { status: result.status } : {}) });
  };
}
