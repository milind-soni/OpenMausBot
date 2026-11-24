// POST /api/bot-moves/:bot { state, team } and DELETE /api/bot-moves/:bot: a server holding one of its bots while it moves
// to another home (a team, My Cloud, or one of the person's computers), letting it go on if the move stops, keeping it as
// the line that opens it there once it arrived, and having it back if My Cloud ended (server/bot-moves.ts). A bot coming
// back is held as "returning" where it comes to and made live there by "arrived"; GET says how the server keeps the bot
// and what its last arrival did. Admin scope: the person's own app runs the move.
import { z } from "zod";

import type { BotMoves } from "../bot-moves.ts";
import { PASS, type RouteHandler } from "./table.ts";

const team = z.object({ id: z.string().regex(/^[\w-]{1,128}$/u), name: z.string().trim().min(1).max(80) });
// New states, not new fields on old ones: an older server answers 400 rather than holding the bot the old way.
const bodySchema = z.discriminatedUnion("state", [
  z.object({ v: z.literal(1), state: z.literal("moving"), team, lapse: z.boolean().optional() }),
  z.object({ v: z.literal(1), state: z.literal("returning"), team }),
  z.object({ v: z.literal(1), state: z.literal("moved"), team }),
  z.object({ v: z.literal(1), state: z.literal("arrived"), team, on: z.array(z.string().regex(/^(?:routine|call|webhook|app-event):[\w-]{1,128}$/u)).max(2_000) }),
  z.object({ v: z.literal(1), state: z.literal("back"), team }),
]);

export function createBotMoveRoutes({ moves, enabled }: { moves: BotMoves | null; enabled: boolean }): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const bot = /^\/api\/bot-moves\/([\w-]{1,128})$/u.exec(path)?.[1];
    if (!bot) return PASS;
    if (!enabled || !moves) { req.resume(); return json(res, 404, { error: "Bots move into a team from My Cloud." }); }
    if (method === "GET") {
      const state = moves.state(bot);
      return state ? json(res, 200, { v: 1, ...state }) : json(res, 404, { error: "This bot is no longer here." });
    }
    if (method === "DELETE") {
      const released = await moves.release(bot);
      return "refused" in released ? json(res, 409, { error: released.refused }) : json(res, 200, { v: 1, released: true });
    }
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const parsed = bodySchema.safeParse(await readBody(req, 512 * 1024));
    if (!parsed.success) return json(res, 400, { error: "send { v: 1, state: \"moving\" | \"returning\" | \"moved\" | \"arrived\" | \"back\", team: { id, name } }" });
    const body = parsed.data;
    if (body.state === "back") {
      const back = moves.back(bot);
      return "refused" in back ? json(res, 409, { error: back.refused }) : json(res, 200, { v: 1, released: true });
    }
    // `held: false`: no hold holds the bot any more (it lapsed, or was let go of); the move holds it again from the copy.
    const notHeld = () => (moves.state(bot)?.holding ? {} : { held: false });
    if (body.state === "arrived") {
      const arrived = await moves.arrived(bot, body.team, body.on);
      return "refused" in arrived ? json(res, 409, { error: arrived.refused, ...notHeld() }) : json(res, 200, { v: 1, ...arrived });
    }
    if (body.state === "moved") {
      const moved = moves.moved(bot, body.team);
      return "refused" in moved ? json(res, 409, { error: moved.refused, ...notHeld() }) : json(res, 200, { v: 1, ...moved });
    }
    const answer = await moves.hold(bot, body.team, body.state === "returning" ? { back: true } : { lapse: body.lapse === true });
    if ("busy" in answer) return json(res, 409, { error: `${answer.busy} is answering. The move goes on once it is done.`, busy: answer.busy });
    if ("refused" in answer) return json(res, 409, { error: answer.refused, ...(answer.here ? { here: true } : {}) });
    return json(res, 200, { v: 1, movedTo: answer.movedTo });
  };
}
