// The Apps card's Postiz routes, for the owner or an admin (request-auth.ts leaves every one off a client's list):
//   GET    /api/postiz                 the connection: how it signs in and where, never a key or a token
//   POST   /api/postiz/sign-in         the `postiz` server set up for Postiz Cloud's sign-in; /api/mcp/servers/postiz/sign-in runs it
//   POST   /api/postiz/key-check       { key, address? } → { ok, tools } or a plain refusal; nothing is saved
//   POST   /api/postiz/check           the saved connection checked again (a revoked sign-in or key shows as such)
//   DELETE /api/postiz                 signed out and the server removed; the key goes with the save that stores it
import type { Postiz } from "../postiz/service.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface PostizRouteDeps {
  postiz: Postiz;
}

export function createPostizRoutes(deps: PostizRouteDeps): RouteHandler {
  const { postiz } = deps;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/postiz" && !path.startsWith("/api/postiz/")) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only the owner or an admin can manage the Postiz connection." });
    res.setHeader("Cache-Control", "no-store");
    if (path === "/api/postiz") {
      if (method === "GET") return json(res, 200, postiz.status());
      if (method !== "DELETE") return json(res, 405, { error: "method not allowed" });
      const done = await postiz.disconnect();
      return done.ok ? json(res, 200, done.status) : json(res, done.status, { error: done.error, code: done.code });
    }
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (path === "/api/postiz/sign-in") {
      const prepared = postiz.prepareSignIn();
      return prepared.ok ? json(res, 200, prepared.status) : json(res, prepared.status, { error: prepared.error, code: prepared.code });
    }
    if (path === "/api/postiz/check") {
      const controller = new AbortController();
      const hangUp = () => { if (!res.writableEnded) controller.abort(); };
      res.once("close", hangUp);
      try {
        return json(res, 200, await postiz.recheck(controller.signal));
      } finally {
        res.off("close", hangUp);
      }
    }
    if (path === "/api/postiz/key-check") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req, 8_192);
      const key = typeof body?.key === "string" ? body.key.trim() : "";
      if (!key || key.length > 512 || /\s/u.test(key)) return json(res, 400, { error: "Paste the Postiz API key alone.", code: "key_rejected" });
      if (body?.address !== undefined && typeof body.address !== "string") return json(res, 400, { error: "Send the Postiz address as text.", code: "address" });
      const checked = await postiz.checkKey(body?.address, key);
      return checked.ok ? json(res, 200, checked) : json(res, checked.status, { ok: false, error: checked.error, code: checked.code });
    }
    return json(res, 404, { error: "not found" });
  };
}
