// Profile menu → "Check for updates" on a server the desktop app does not
// manage (MOCA-276).
//
//   GET /api/updates/check  whether a newer release exists, and how this install is updated
//
// Read-only and the same for everyone, so chat-only sessions may ask too
// (server/request-auth.ts CLIENT_ALLOW). The lookup itself is cached for an
// hour in server/update-check.ts.
import type { UpdateCheck } from "../update-check.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface UpdateCheckRouteDeps {
  check(): Promise<UpdateCheck>;
}

export function createUpdateCheckRoutes(deps: UpdateCheckRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path !== "/api/updates/check" || method !== "GET") return PASS;
    try {
      return json(res, 200, await deps.check());
    } catch (error) {
      return json(res, 502, { error: `Could not check for updates: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
}
