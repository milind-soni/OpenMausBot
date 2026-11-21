// GET /api/diagnostics/performance: the performance recorder's plain lines for the desktop's diagnostics export.
// GET /api/diagnostics/bots: every bot's processes, threads, memory and CPU at the last sample (perf/bot-footprint.ts), bot
// ids and numbers only. POST /api/diagnostics/launch: the desktop app's main process and its page each hand in their part
// of the launch record (perf/launch-timings.ts), which keeps only checked numbers and fixed codes. All admin scope (request-auth's default), so on a Cloud home a bot's shell, a service-trust
// loopback caller, never reaches them.
import type { BotFootprintReport } from "../perf/bot-footprint.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const PERF_DIAGNOSTICS_PATH = "/api/diagnostics/performance";
export const BOT_FOOTPRINT_PATH = "/api/diagnostics/bots";

export const LAUNCH_PATH = "/api/diagnostics/launch";
const LAUNCH_BODY_MAX = 16 * 1024;

export function createPerfDiagnosticsRoutes(deps: { text(): string; bots?(): BotFootprintReport | null; launch?(part: unknown): { ok: boolean; complete: boolean } | null }): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (method === "POST" && path === LAUNCH_PATH) {
      res.setHeader("cache-control", "no-store");
      const noted = deps.launch ? deps.launch(await readBody(req, LAUNCH_BODY_MAX).catch(() => null)) : null;
      return json(res, noted ? 200 : 404, noted ?? { ok: false, complete: false });
    }
    if (method !== "GET" || (path !== PERF_DIAGNOSTICS_PATH && path !== BOT_FOOTPRINT_PATH)) return PASS;
    res.setHeader("cache-control", "no-store");
    if (path === BOT_FOOTPRINT_PATH) return json(res, 200, { bots: deps.bots?.() ?? null });
    return json(res, 200, { text: deps.text() });
  };
}
