// GET /api/updates/check: whether a newer version exists, and how this install is updated. Read-only, so client sessions may ask.
import { serverVersion } from "../environment.ts";
import { SERVER_ROOT } from "../proxy-paths.ts";
import { createUpdateChecker, installKind, updateChannel, type UpdateCheck } from "../update-check.ts";
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

export function serverUpdateChecker(where: { desktopManaged: boolean; managed: boolean }): () => Promise<UpdateCheck> {
  return createUpdateChecker({ current: serverVersion(), install: installKind({ ...where, serverRoot: SERVER_ROOT }), channel: updateChannel() });
}
