// GET /api/diagnostics/performance: the performance recorder's plain lines for the desktop's diagnostics export. Admin
// scope (request-auth's default), so on a Cloud home a bot's shell, a service-trust loopback caller, never reaches it.
import { PASS, type RouteHandler } from "./table.ts";

export const PERF_DIAGNOSTICS_PATH = "/api/diagnostics/performance";

export function createPerfDiagnosticsRoutes(deps: { text(): string }): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path !== PERF_DIAGNOSTICS_PATH || method !== "GET") return PASS;
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { text: deps.text() });
  };
}
