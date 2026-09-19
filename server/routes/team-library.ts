// The team library HTTP routes, extracted verbatim from index.ts's dispatch
// chain. Path matching, methods, and status codes are unchanged; the handler
// returns false for anything it does not own so the chain falls through in
// the same order.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { fetchGithubTeam, fetchLibraryTeam, fetchTeamCatalog } from "../team-library.ts";

export async function handleTeamLibrary(req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> {
  const { method, path } = rctx;
  if (method === "GET" && path === "/api/team-library/catalog") {
    try {
      json(res, 200, await fetchTeamCatalog());
      return true;
    } catch (error) {
      json(res, 502, { error: error instanceof Error ? error.message : "The team library is unavailable" });
      return true;
    }
  }
  const m = path.match(/^\/api\/team-library\/teams\/([a-z0-9][a-z0-9-]*)$/);
  if (m && method === "GET") {
    try {
      json(res, 200, await fetchLibraryTeam(m[1]));
      return true;
    } catch (error) {
      const status = (error as { status?: number }).status === 404 ? 404 : 502;
      json(res, status, { error: error instanceof Error ? error.message : "The team could not be loaded" });
      return true;
    }
  }
  if (method === "POST" && path === "/api/team-library/github") {
    const body = await readBody(req);
    if (typeof body.url !== "string" || !body.url.trim()) {
      json(res, 400, { error: "A GitHub URL is required" });
      return true;
    }
    try {
      json(res, 200, await fetchGithubTeam(body.url));
      return true;
    } catch (error) {
      const status = (error as { status?: number }).status === 404 ? 404 : 400;
      json(res, status, { error: error instanceof Error ? error.message : "The GitHub team could not be loaded" });
      return true;
    }
  }
  return false;
}
