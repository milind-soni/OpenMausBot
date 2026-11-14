// POST /api/bot-moves/:bot { state: "moving" | "moved" | "back", team } and DELETE /api/bot-moves/:bot: a server holding
// one of its bots while it moves to another home (a team, or My Cloud), letting it go on if the move stops, keeping it as
// the line that opens it there once it arrived, and having it back if My Cloud ended (server/bot-moves.ts). Admin scope:
// the person's own app runs the move.
import { z } from "zod";

import type { BotMoves } from "../bot-moves.ts";
import { PASS, type RouteHandler } from "./table.ts";

const bodySchema = z.object({
  v: z.literal(1),
  state: z.enum(["moving", "moved", "back"]),
  team: z.object({ id: z.string().regex(/^[\w-]{1,128}$/u), name: z.string().trim().min(1).max(80) }),
});

export function createBotMoveRoutes({ moves, enabled }: { moves: BotMoves | null; enabled: boolean }): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const bot = /^\/api\/bot-moves\/([\w-]{1,128})$/u.exec(path)?.[1];
    if (!bot) return PASS;
    if (!enabled || !moves) { req.resume(); return json(res, 404, { error: "Bots move into a team from My Cloud." }); }
    if (method === "DELETE") {
      const released = await moves.release(bot);
      return "refused" in released ? json(res, 409, { error: released.refused }) : json(res, 200, { v: 1, released: true });
    }
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const parsed = bodySchema.safeParse(await readBody(req, 16 * 1024));
    if (!parsed.success) return json(res, 400, { error: "send { v: 1, state: \"moving\" | \"moved\" | \"back\", team: { id, name } }" });
    const { state, team } = parsed.data;
    if (state === "back") {
      const back = moves.back(bot);
      return "refused" in back ? json(res, 409, { error: back.refused }) : json(res, 200, { v: 1, released: true });
    }
    const answer = state === "moving" ? await moves.hold(bot, team) : moves.moved(bot, team);
    if ("busy" in answer) return json(res, 409, { error: `${answer.busy} is answering. The move goes on once it is done.`, busy: answer.busy });
    if ("refused" in answer) return json(res, 409, { error: answer.refused });
    return json(res, 200, { v: 1, movedTo: answer.movedTo });
  };
}
