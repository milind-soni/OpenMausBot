// GET/PUT /api/time-zone: the zone this server tells time in (server/time-zone.ts). Both need admin scope (request-auth's
// default), so only the owner's own devices change it. Anywhere but a Cloud home the computer's clock is already the
// person's, and PUT is refused.
import { adoptSavedTimeZone, currentTimeZone, knownTimeZone, useTimeZone } from "../time-zone.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TimeZoneRouteDeps {
  /** Only a Cloud home adopts its owner's zone. */
  adopts: boolean;
  dataDir: string;
  /** After the zone changed: routines move their local times and clients are told. */
  changed(zone: string): void;
}

/** On a Cloud home it also adopts the zone saved last time; index.ts builds it before routines start. */
export function createTimeZoneRoutes(deps: TimeZoneRouteDeps): RouteHandler {
  if (deps.adopts) adoptSavedTimeZone(deps.dataDir);
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== "/api/time-zone") return PASS;
    if (method === "GET") return json(res, 200, { timeZone: currentTimeZone(), adopts: deps.adopts });
    if (method !== "PUT") return PASS;
    if (!deps.adopts) return json(res, 409, { error: "This computer tells time in its own time zone." });
    const zone = knownTimeZone((await readBody(req, 4096) as { timeZone?: unknown } | null)?.timeZone);
    if (!zone) return json(res, 400, { error: "timeZone must be an IANA time zone name, like Europe/London." });
    const changed = useTimeZone(deps.dataDir, zone);
    if (changed) deps.changed(zone);
    return json(res, 200, { timeZone: zone, changed });
  };
}
