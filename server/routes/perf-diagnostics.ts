// GET /api/diagnostics/performance: the performance recorder's plain lines for the desktop's diagnostics export.
// GET /api/diagnostics/bots: every bot's processes, threads, memory and CPU at the last sample (perf/bot-footprint.ts), bot
// ids and numbers only. Both admin scope (request-auth's default), so on a Cloud home a bot's shell, a service-trust
// loopback caller, never reaches them.
import type { BotFootprintReport } from "../perf/bot-footprint.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const PERF_DIAGNOSTICS_PATH = "/api/diagnostics/performance";
export const BOT_FOOTPRINT_PATH = "/api/diagnostics/bots";

export function createPerfDiagnosticsRoutes(deps: { text(): string; bots?(): BotFootprintReport | null }): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "GET" || (path !== PERF_DIAGNOSTICS_PATH && path !== BOT_FOOTPRINT_PATH)) return PASS;
    res.setHeader("cache-control", "no-store");
    if (path === BOT_FOOTPRINT_PATH) return json(res, 200, { bots: deps.bots?.() ?? null });
    return json(res, 200, { text: deps.text() });
  };
}
