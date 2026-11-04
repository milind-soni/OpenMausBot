import { z } from "zod";
import { keplerNotify, readKeplerInbox } from "../peers/kepler.ts";
import { PASS, type RouteHandler } from "./table.ts";

const notifyBody = z.object({
  botId: z.string().min(1),
  botName: z.string().optional(),
  threadId: z.string().min(1),
  summary: z.string().min(1),
  urgency: z.enum(["low", "normal", "high"]).optional(),
  refs: z.array(z.string()).optional(),
});

/** Musterd → Kepler handoff drop (outbound peer). */
export function createKeplerPeerRoutes(): RouteHandler {
  return async (ctx) => {
    if (ctx.path === "/api/peers/kepler/notify" && ctx.method === "POST") {
      const raw = await ctx.readBody(ctx.req);
      const parsed = notifyBody.safeParse(raw);
      if (!parsed.success) return ctx.json(ctx.res, 400, { error: parsed.error.message });
      try {
        const result = keplerNotify(parsed.data);
        return ctx.json(ctx.res, 200, result);
      } catch (error) {
        return ctx.json(ctx.res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (ctx.path === "/api/peers/kepler/inbox" && ctx.method === "GET") {
      const limit = Number(ctx.url.searchParams.get("limit") || "20");
      return ctx.json(ctx.res, 200, { items: readKeplerInbox(Number.isFinite(limit) ? limit : 20) });
    }
    return PASS;
  };
}
