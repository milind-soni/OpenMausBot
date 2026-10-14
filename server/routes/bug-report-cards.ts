// POST /api/bots/<bot>/bug-report-cards/<message>/(sent|dismissed) with {threadId, reportId?}. The desktop app sends the
// report itself; this records what the person did with the bot's draft and resumes the bot.
import { settleBugReport, type BugReportSettleDeps } from "../bug-report-card.ts";
import { PASS, type RouteHandler } from "./table.ts";

const CARD = /^\/api\/bots\/([\w-]+)\/bug-report-cards\/([\w-]+)\/(sent|dismissed)$/u;

export function createBugReportCardRoutes(deps: BugReportSettleDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const m = CARD.exec(path);
    if (!m || method !== "POST") return PASS;
    const body = await readBody(req);
    const fields = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const result = settleBugReport(deps, m[1]!, String(fields.threadId ?? ""), m[2]!, m[3] === "sent" ? "sent" : "dismissed", fields.reportId);
    return json(res, result.status, result.body);
  };
}
