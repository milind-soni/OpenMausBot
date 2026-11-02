// /api/places/elsewhere: the person's app tells this place the names of the bots in their other places (PUT, replacing what
// it said before), and reads back what it said (GET). Only this place's owner: the app on this computer, or the owner's
// session on their own server or Cloud; never a team's place or one others sign in to.
import type { RequestAuth } from "../request-auth.ts";
import { elsewhereSchema, type createPlacesElsewhere } from "../places-elsewhere.ts";
import { PASS, type RouteHandler } from "./table.ts";

const PATH = "/api/places/elsewhere";

export function createPlacesElsewhereRoutes({ elsewhere, owner }: { elsewhere: ReturnType<typeof createPlacesElsewhere>; owner(auth: RequestAuth): boolean }): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== PATH) return PASS;
    res.setHeader("cache-control", "no-store");
    if (!owner(auth)) { req.resume(); return json(res, 403, { error: "Only this place's owner can say where their other bots live." }); }
    if (method === "GET") return json(res, 200, elsewhere.read() ?? { v: 1, places: [] });
    if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
    const body = elsewhereSchema.safeParse(await readBody(req, 256 * 1024));
    if (!body.success) return json(res, 400, { error: "send { v: 1, self: { name, kind }, places: [{ name, kind, bots }] }" });
    elsewhere.write(body.data);
    return json(res, 200, { ok: true });
  };
}
