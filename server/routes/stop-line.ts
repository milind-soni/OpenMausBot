// Whether a line a person typed is a stop. The Team map asks before it sends an `@everyone` line: a stop goes to every bot at
// once, where each bot's own send path stops it, and anything else goes to the Chief. The rule is that send path's own
// (room-holds.ts), so the map never keeps a copy of it.
//   POST /api/stop-line  {text}  →  {stop}
import { isStopCommand } from "../room-holds.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** A stop is a few words; a longer line is not one, whatever it holds. */
const TEXT_MAX = 2_000;

export function createStopLineRoutes(): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (!(method === "POST" && path === "/api/stop-line")) return PASS;
    let body: unknown;
    try { body = await readBody(req, 8_192); } catch { return json(res, 400, { error: "expected a small JSON body" }); }
    const text = body && typeof body === "object" ? (body as { text?: unknown }).text : undefined;
    if (typeof text !== "string") return json(res, 400, { error: "text must be a string" });
    return json(res, 200, { stop: text.length <= TEXT_MAX && isStopCommand(text) });
  };
}
