import type { BoatRecovery } from "../boat-recovery.ts";
import type { BotRecord, Store } from "../store.ts";
import type { RemoteComputerProvider } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface CloudComputerRecoveryRouteDeps {
  store: Pick<Store, "bot">;
  boatRecovery: Pick<BoatRecovery, "status" | "restart" | "replace" | "stuck">;
  computerProviderConfigTransitions: Pick<Set<RemoteComputerProvider>, "has">;
  providerTransitionMessage(provider: RemoteComputerProvider): string;
  botHasActiveTurn(botId: string): boolean;
  botComputerControlKey(bot: BotRecord): string;
  claimBotComputerLifecycle(botId: string, allowPreview?: boolean): () => void;
  cloudComputerUsed(owner: string): void;
}

/** GET and POST /api/bots/:id/computer/recovery: what MausBot is doing about a bot's cloud computer that stopped answering,
 * and the computer panel's Restart computer and Replace computer. Admin-only like every computer route. */
export function createCloudComputerRecoveryRoutes(deps: CloudComputerRecoveryRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/recovery$/);
    if (!m || (method !== "GET" && method !== "POST")) return PASS;
    const bot = deps.store.bot(m[1]!);
    if (!bot) return json(res, 404, { error: "no such bot" });
    const owner = deps.botComputerControlKey(bot);
    if (method === "GET") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, { recovery: owner === bot.id ? deps.boatRecovery.status(owner) : null });
    }
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    const action = (await readBody(req))?.action;
    if (action !== "restart" && action !== "replace") return json(res, 400, { error: "action must be restart or replace" });
    if (bot.cloudBackend === "vps") return json(res, 409, { error: "This bot uses a VPS, not a cloud computer." });
    if (owner !== bot.id) return json(res, 409, { error: "Manage this shared computer from the Team map" });
    if (deps.computerProviderConfigTransitions.has("box")) return json(res, 409, { error: deps.providerTransitionMessage("box") });
    // A turn may be waiting on the computer that stopped answering; a working computer is left alone while it is used.
    if (deps.botHasActiveTurn(bot.id) && !deps.boatRecovery.stuck(owner)) {
      return json(res, 409, { error: "this bot is using its cloud computer — interrupt it first" });
    }
    const release = deps.claimBotComputerLifecycle(bot.id, true);
    try {
      return json(res, 200, action === "restart" ? await deps.boatRecovery.restart(owner) : await deps.boatRecovery.replace(owner));
    } finally {
      release();
      deps.cloudComputerUsed(owner);
    }
  };
}
