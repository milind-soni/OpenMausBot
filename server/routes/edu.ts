import type { EduBrainView } from "../../shared/edu-brain.ts";
import type { EduBrainStatus, EduBot } from "../edu-brain.ts";
import { eduDecisionRefusal, type EduProposals } from "../edu-proposals.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

type Bot = EduBot & { name: string; color: string };

export interface EduRouteDeps {
  bot(id: string): Bot | null | undefined;
  status(bot: Bot): Promise<EduBrainStatus>;
  proposals: Pick<EduProposals, "view" | "decideFor" | "rights">;
  /** The packaged desktop app. */
  desktop: boolean;
}

/** GET /api/bots/:id/edu: the bot's Edu brain and its pending proposals. POST /api/bots/:id/edu/proposals/:pid
 * `{action: "approve" | "reject"}`. GET /api/edu/rights: what this caller may decide. */
export function createEduRoutes(deps: EduRouteDeps): RouteHandler {
  return async ({ req, path, method, auth, res, json, readBody }) => {
    if (path === "/api/edu/rights") return method === "GET" ? json(res, 200, deps.proposals.rights(auth)) : json(res, 405, { error: "method not allowed" });
    const view = path.match(/^\/api\/bots\/([\w-]+)\/edu$/);
    const decide = path.match(/^\/api\/bots\/([\w-]+)\/edu\/proposals\/([^/]+)$/);
    if (!view && !decide) return PASS;
    const bot = deps.bot((view ?? decide)![1]);
    if (view) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner or a workspace admin can see this bot's Edu brain." });
      if (!bot) return json(res, 404, { error: "no such bot" });
      const status = await deps.status(bot);
      const body: EduBrainView = {
        state: status.state, mode: status.mode, home: status.home,
        ...(status.brain ? { brain: status.brain } : {}), ...(status.version ? { version: status.version } : {}), ...(status.reason ? { reason: status.reason } : {}),
        ...(status.brokenFolder ? { brokenFolder: true } : {}),
        ...(status.state === "ready" ? await deps.proposals.view(bot, deps.proposals.rights(auth).mayApprove) : { proposals: [], mayApprove: false }),
      };
      return json(res, 200, body);
    }
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readBody(req);
    const action = body && typeof body === "object" ? (body as { action?: unknown }).action : undefined;
    if (action !== "approve" && action !== "reject") return json(res, 400, { error: "action must be approve or reject" });
    const refusal = eduDecisionRefusal(auth, deps.desktop, action === "approve");
    if (refusal) return json(res, 403, { error: refusal });
    if (!bot) return json(res, 404, { error: "no such bot" });
    let id: string;
    try { id = decodeURIComponent(decide![2]); } catch { return json(res, 400, { error: "That isn't an Edu proposal id." }); }
    const result = await deps.proposals.decideFor(bot, id, action === "approve");
    return result.ok ? json(res, 200, result) : json(res, result.status, { error: result.error });
  };
}
