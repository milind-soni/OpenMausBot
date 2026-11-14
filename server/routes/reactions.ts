import { normalizeReaction, REACTIONS, type Reaction, type ReactionDelivery } from "../../shared/reactions.ts";
import type { Reactor } from "../reactions.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Message } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ReactionRouteDeps {
  react(input: {
    auth: RequestAuth; threadId: string; messageId: string; emoji: Reaction; reactor: Reactor; on?: boolean;
  }): Promise<{ message: Message; delivery: ReactionDelivery }>;
  /** Who is reacting, from their session alone: a request body never names them. */
  reactorFor(auth: RequestAuth): Reactor;
  cloudGuestSendRefusal(auth: RequestAuth, threadId: string): string | null;
}

export function createReactionRoutes(deps: ReactionRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/reactions$/);
    if (!m || method !== "POST") return PASS;
    const body = await readBody(req);
    const emoji = normalizeReaction(body?.emoji);
    if (!emoji) return json(res, 400, { error: `emoji must be one of ${REACTIONS.join(" ")}` });
    if (body.on !== undefined && typeof body.on !== "boolean") return json(res, 400, { error: "on must be true or false" });
    const notYours = deps.cloudGuestSendRefusal(auth, m[1]);
    if (notYours) return json(res, 403, { error: notYours });
    try {
      return json(res, 200, await deps.react({ auth, threadId: m[1], messageId: m[2], emoji, reactor: deps.reactorFor(auth), on: body.on }));
    } catch (error) {
      const { status, code } = error as { status?: unknown; code?: unknown };
      if (typeof status !== "number") throw error;
      return json(res, status, { error: error instanceof Error ? error.message : String(error), ...(typeof code === "string" ? { code } : {}) });
    }
  };
}
