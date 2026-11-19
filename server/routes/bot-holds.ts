// Pausing a bot, a department or every bot: GET what is paused; POST {kind, id, paused} pauses or resumes one
// ({kind: "all", paused} every bot), and pausing also stops the work its bots are doing now. POST /api/turns/stop stops
// that work without pausing ({all: true} or {botIds}). Admin-scope routes: on a Team Cloud only an owner or admin pauses.
import type { IncomingMessage } from "node:http";
import { z } from "zod";

import type { BotHolds, PauseKind } from "../host/bot-holds.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotHoldRouteDeps {
  holds: BotHolds;
  /** The bot's or department's name when it exists here; null when it does not. */
  named(kind: "bot" | "department", id: string): string | null;
  /** Stops every running turn, routine run and hand-off of these bots; how many conversations it stopped. */
  stop(botIds: readonly string[]): Promise<number>;
  /** Every bot's id. */
  bots(): string[];
  /** Records the change in the admin activity log. */
  audit(entry: { kind: PauseKind; id: string; name: string; paused: boolean }, auth: RequestAuth, req: IncomingMessage): void;
}

const body = z.union([
  z.object({ kind: z.enum(["bot", "department"]), id: z.string().trim().min(1).max(200), paused: z.boolean() }).strict(),
  z.object({ kind: z.literal("all"), paused: z.boolean() }).strict(),
]);
const stopBody = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ botIds: z.array(z.string().trim().min(1).max(200)).min(1).max(1_000) }).strict(),
]);
/** What the admin activity log names an all-bots pause by. */
const ALL = { id: "all", name: "Every bot" };

export function createBotHoldRoutes(deps: BotHoldRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path === "/api/turns/stop" && method === "POST") {
      const parsed = stopBody.safeParse(await readBody(req, 64_000).catch(() => null));
      if (!parsed.success) return void json(res, 400, { error: "Send all: true, or botIds: the bots whose work to stop." });
      const botIds = "all" in parsed.data ? deps.bots() : [...new Set(parsed.data.botIds)];
      const missing = botIds.filter((id) => deps.named("bot", id) === null);
      if (missing.length) return void json(res, 404, { error: `No such bot: ${missing.join(", ")}.`, missing });
      return void json(res, 200, { botIds, stopped: await deps.stop(botIds) });
    }
    if (path !== "/api/paused") return PASS;
    if (method === "GET") return void json(res, 200, { ...deps.holds.state(), heldBots: deps.holds.heldBots() });
    if (method !== "POST") return PASS;
    const parsed = body.safeParse(await readBody(req, 4_096).catch(() => null));
    if (!parsed.success) return void json(res, 400, { error: "Send kind (bot or department) with id, or kind all, and paused (true or false)." });
    const { kind, paused } = parsed.data;
    const id = parsed.data.kind === "all" ? ALL.id : parsed.data.id;
    const name = parsed.data.kind === "all" ? ALL.name : deps.named(parsed.data.kind, id);
    if (name === null) return void json(res, 404, { error: kind === "bot" ? "No such bot." : "No such department." });
    const { state, newlyHeld } = deps.holds.set(kind, id, paused);
    const stopped = paused && newlyHeld.length ? await deps.stop(newlyHeld) : 0;
    deps.audit({ kind, id, name, paused }, auth, req);
    json(res, 200, { ...state, heldBots: deps.holds.heldBots(), stopped });
  };
}
