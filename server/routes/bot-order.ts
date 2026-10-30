import type { VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotOrderRouteDeps {
  store: Pick<Store, "bot" | "reorderBots">;
  /** The same filter the GET /api/bots listing applies to this caller. */
  visibleFor(auth: RequestAuth): VisibleSet;
}

/** The fleet's order is one list every client shows (the desktop sidebar, a phone's roster). A reorder names only
 * the bots it moves (shared/bot-order.ts); the rest keep their places. */
export function createBotOrderRoutes(deps: BotOrderRouteDeps): RouteHandler {
  const { store, visibleFor } = deps;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/bots/order" || method !== "PUT") return PASS;
    const body = await readBody(req);
    const botIds: unknown = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((key) => key === "botIds")
      ? (body as { botIds?: unknown }).botIds : undefined;
    if (!Array.isArray(botIds) || !botIds.length || botIds.some((id) => typeof id !== "string" || !id) || new Set(botIds).size !== botIds.length) {
      return json(res, 400, { error: "botIds must be a non-empty array of distinct bot ids" });
    }
    // A restricted viewer gets the same answer for a hidden bot as for a missing one, so the id list cannot probe the fleet.
    const visible = visibleFor(auth);
    for (const id of botIds as string[]) {
      if (!store.bot(id) || !visible.bot(id)) return json(res, 400, { error: `unknown bot: ${id}` });
    }
    const bots = store.reorderBots(botIds as string[]);
    if (!bots) return json(res, 400, { error: "botIds must be a non-empty array of distinct bot ids" });
    return json(res, 200, { botIds: bots.filter((bot) => visible.bot(bot.id)).map((bot) => bot.id) });
  };
}
