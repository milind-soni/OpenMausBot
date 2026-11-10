// GET /api/updates/check: whether a newer version exists, and how this install is updated. Read-only, so client sessions may ask.
// GET and POST /api/updates/server: the Update server button, for an admin's session only (server/server-update.ts).
import type { IncomingMessage } from "node:http";

import type { AdminActor } from "../admin-activity.ts";
import { serverVersion } from "../environment.ts";
import { SERVER_ROOT } from "../proxy-paths.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createServerUpdater, SERVER_UPDATE_DIR, SERVER_UPDATE_DIR_ENV, type ServerUpdater } from "../server-update.ts";
import { createUpdateChecker, installKind, updateChannel, type UpdateCheck } from "../update-check.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface UpdateCheckRouteDeps {
  check(): Promise<UpdateCheck>;
  server?: ServerUpdater;
  actor?(auth: RequestAuth, req: IncomingMessage): AdminActor;
}

/** SECURITY: a person's admin session, never loopback: on a server, loopback is a bot's shell or a process beside it. */
export function mayUpdateServer(auth: RequestAuth): boolean {
  return auth.kind === "session" && auth.scopes.includes("admin");
}

export function createUpdateCheckRoutes(deps: UpdateCheckRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, auth }) => {
    if (path === "/api/updates/server" && deps.server && (method === "GET" || method === "POST")) {
      if (!mayUpdateServer(auth)) return json(res, 403, { error: "Only an admin of this server, signed in, can update it.", code: "admin_only" });
      if (method === "GET") return json(res, 200, await deps.server.status());
      const done = await deps.server.request(deps.actor?.(auth, req) ?? { kind: "loopback" });
      return json(res, done.status, done.body);
    }
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

/** Both routes' parts for this server: one shared check, and the button where the install has one. */
export function updateRouteDeps(where: {
  desktopManaged: boolean;
  managed: boolean;
  dataDir: string;
  activeTurns(): number;
  actor(auth: RequestAuth, req: IncomingMessage): AdminActor;
}): UpdateCheckRouteDeps {
  const install = installKind({ ...where, serverRoot: SERVER_ROOT });
  const check = createUpdateChecker({ current: serverVersion(), install, channel: updateChannel() });
  const dir = process.env[SERVER_UPDATE_DIR_ENV]?.trim() || (install === "docker" ? SERVER_UPDATE_DIR : undefined);
  const server = createServerUpdater({ dir, dataDir: where.dataDir, install, version: serverVersion(), check, activeTurns: where.activeTurns });
  return { check, server, actor: where.actor };
}
