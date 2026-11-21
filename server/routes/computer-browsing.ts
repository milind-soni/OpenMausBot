import type { MapBrowsingPayload } from "../../shared/map-computer.ts";
import type { BotRecord, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ComputerBrowsingRouteDeps {
  store: Pick<Store, "bots">;
  botHasActiveTurn(botId: string): boolean;
  /** The address in front of the bot's built-in browser while its turn uses it, or null; never starts one. */
  browserPageUrl(bot: BotRecord): string | null;
}

/** A web page's host only: its path and query can hold private details. */
export function siteOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.replace(/^www\./i, "") || null;
  } catch {
    return null;
  }
}

/** GET /api/computers/browsing → `{ bots: [{ botId, site }] }`: the site each working bot's browser shows. Admin-only like every computer route. */
export function createComputerBrowsingRoutes(deps: ComputerBrowsingRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "GET" || path !== "/api/computers/browsing") return PASS;
    res.setHeader("cache-control", "private, no-store");
    const bots = deps.store.bots.flatMap((bot) => {
      if (bot.hidden || !deps.botHasActiveTurn(bot.id)) return [];
      const site = siteOf(deps.browserPageUrl(bot));
      return site ? [{ botId: bot.id, site }] : [];
    });
    const payload: MapBrowsingPayload = { bots };
    return json(res, 200, payload);
  };
}
