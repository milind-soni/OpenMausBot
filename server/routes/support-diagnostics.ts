import { arch, platform, release } from "node:os";

import { supportDiagnostics } from "../devs-report.ts";
import type { RecentLog } from "../recent-log.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const SUPPORT_DIAGNOSTICS_PATH = "/api/support/diagnostics";

/** GET SUPPORT_DIAGNOSTICS_PATH: what Contact support's "Include diagnostics" adds, the facts a @devs report attaches without its
 * conversation. Security: an admin's only, as the server's warnings on a Team Cloud are everyone's. */
export function createSupportDiagnosticsRoutes(deps: { installId: string; appVersion: () => string; runsOn: string; language: () => string | undefined; recentLog: RecentLog;
  now?: () => number }): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path !== SUPPORT_DIAGNOSTICS_PATH) return PASS;
    if (method !== "GET") return json(res, 405, { error: "Use GET." });
    const language = deps.language();
    return json(res, 200, { text: supportDiagnostics({ installId: deps.installId, appVersion: deps.appVersion(), runsOn: deps.runsOn, os: `${platform()} ${release()} ${arch()}`,
      node: process.version, uptimeSeconds: Math.round(process.uptime()), ...(language ? { language } : {}), now: (deps.now ?? Date.now)(), log: deps.recentLog() }) });
  };
}
