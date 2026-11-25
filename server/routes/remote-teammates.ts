// Teammates on other servers (server/remote-teammates.ts): list, add, check and remove.
//
// Security: none of these paths is in CLIENT_ALLOW (server/request-auth.ts), so only the owner and admins reach them. A
// saved key lets this server call a bot elsewhere, and no answer ever carries it back.
import { checkRemote, RemoteTeammateError, type RemoteCallOptions, type RemoteTeammates } from "../remote-teammates.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface RemoteTeammateRouteDeps {
  teammates: RemoteTeammates;
  fetch?: RemoteCallOptions["fetch"];
}

const ONE = /^\/api\/remote-teammates\/([0-9a-f-]{36})(\/check)?$/;

export function createRemoteTeammateRoutes(deps: RemoteTeammateRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path === "/api/remote-teammates") {
      if (method === "GET") return json(res, 200, { teammates: deps.teammates.list() });
      if (method !== "POST") return json(res, 405, { error: "use GET or POST" });
      try {
        return json(res, 201, { teammate: deps.teammates.add(await readBody(req, 16_000)) });
      } catch (error) {
        return refused(res, json, error);
      }
    }
    const match = ONE.exec(path);
    if (!match) return PASS;
    if (match[2]) {
      if (method !== "POST") return json(res, 405, { error: "use POST" });
      const teammate = deps.teammates.get(match[1]!);
      if (!teammate) return json(res, 404, { error: "no such teammate" });
      return json(res, 200, await checkRemote(teammate, { fetch: deps.fetch }));
    }
    if (method !== "DELETE") return json(res, 405, { error: "use DELETE" });
    try {
      return deps.teammates.remove(match[1]!) ? json(res, 200, { removed: true }) : json(res, 404, { error: "no such teammate" });
    } catch (error) {
      return refused(res, json, error);
    }
  };
}

function refused(res: Parameters<RouteHandler>[0]["res"], json: Parameters<RouteHandler>[0]["json"], error: unknown): void {
  if (error instanceof RemoteTeammateError) return json(res, error.status, { error: error.message });
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) return json(res, status, { error: error instanceof Error ? error.message : "bad request" });
  throw error;
}
