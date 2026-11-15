// Pausing a bot or a department: GET what is paused; POST {kind, id, paused} pauses or resumes one, and pausing
// also stops the work its bots are doing now. Admin-scope routes: on a Team Cloud only an owner or admin pauses.
import type { IncomingMessage } from "node:http";
import { z } from "zod";

import type { BotHolds } from "../host/bot-holds.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotHoldRouteDeps {
  holds: BotHolds;
  /** The bot's or department's name when it exists here; null when it does not. */
  named(kind: "bot" | "department", id: string): string | null;
  /** Stops every running turn, routine run and hand-off of these bots; how many conversations it stopped. */
  stop(botIds: readonly string[]): Promise<number>;
  /** Records the change in the admin activity log. */
  audit(entry: { kind: "bot" | "department"; id: string; name: string; paused: boolean }, auth: RequestAuth, req: IncomingMessage): void;
}

const body = z.object({ kind: z.enum(["bot", "department"]), id: z.string().trim().min(1).max(200), paused: z.boolean() }).strict();

export function createBotHoldRoutes(deps: BotHoldRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/paused") return PASS;
    if (method === "GET") return void json(res, 200, { ...deps.holds.state(), heldBots: deps.holds.heldBots() });
    if (method !== "POST") return PASS;
    const parsed = body.safeParse(await readBody(req, 4_096).catch(() => null));
    if (!parsed.success) return void json(res, 400, { error: "Send kind (bot or department), id and paused (true or false)." });
    const { kind, id, paused } = parsed.data;
    const name = deps.named(kind, id);
    if (name === null) return void json(res, 404, { error: kind === "bot" ? "No such bot." : "No such department." });
    const { state, newlyHeld } = deps.holds.set(kind, id, paused);
    const stopped = paused && newlyHeld.length ? await deps.stop(newlyHeld) : 0;
    deps.audit({ kind, id, name, paused }, auth, req);
    json(res, 200, { ...state, heldBots: deps.holds.heldBots(), stopped });
  };
}
