import { validZone } from "../host/check-plan.ts";
import type { PresenceAnswer } from "../host/brief.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface PresenceRouteDeps {
  isOwner(auth: RequestAuth): boolean;
  active(source: "desktop" | "phone", timeZone?: string): Promise<PresenceAnswer>;
}

const IANA_ZONE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/;

/** POST /api/presence/active {source, timeZone}: the person opened or used the app. Only the owner's counts. */
export function createPresenceRoutes(deps: PresenceRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (method !== "POST" || path !== "/api/presence/active") return PASS;
    const body: unknown = await readBody(req, 4096);
    const given = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const source = given.source === "phone" ? "phone" : "desktop";
    const timeZone = typeof given.timeZone === "string" && given.timeZone.length <= 128 && IANA_ZONE.test(given.timeZone) ? validZone(given.timeZone) : undefined;
    // A guest's activation is not the person's: answered, never recorded.
    if (!deps.isOwner(auth)) return json(res, 200, { ok: true, returned: false });
    return json(res, 200, { ok: true, ...(await deps.active(source, timeZone)) });
  };
}
