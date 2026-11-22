import type { EduBrainView } from "../../shared/edu-brain.ts";
import type { EduBrainStatus, EduBot } from "../edu-brain.ts";
import type { EduCrew } from "../edu-crew.ts";
import { eduDecisionRefusal, type EduProposals } from "../edu-proposals.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

type Bot = EduBot & { name: string; color: string; eduCrew?: boolean; threadId?: string };

export interface EduRouteDeps {
  bot(id: string): Bot | null | undefined;
  status(bot: Bot): Promise<EduBrainStatus>;
  proposals: Pick<EduProposals, "view" | "decideFor" | "rights">;
  crew: Pick<EduCrew, "view" | "details" | "cancelFor">;
  /** The packaged desktop app. */
  desktop: boolean;
}

/** Edu crew needs a local Edu brain, so a cloud brain bot is offered none; one that had it on sees why it can't run. */
const crewOffered = (bot: Bot, status: EduBrainStatus) => bot.eduCrew === true || (status.state === "ready" && bot.eduBrain?.mode !== "cloud");

/** GET /api/bots/:id/edu: the bot's Edu brain, its pending proposals and its crew. POST /api/bots/:id/edu/proposals/:pid
 * `{action: "approve" | "reject"}`. GET /api/edu/rights: what this caller may decide. GET /api/edu/crew/:job: a crew
 * job's details; POST /api/edu/crew/:job/cancel stops it. */
export function createEduRoutes(deps: EduRouteDeps): RouteHandler {
  return async ({ req, path, method, auth, res, json, readBody }) => {
    if (path === "/api/edu/rights") return method === "GET" ? json(res, 200, deps.proposals.rights(auth)) : json(res, 405, { error: "method not allowed" });
    const view = path.match(/^\/api\/bots\/([\w-]+)\/edu$/);
    const decide = path.match(/^\/api\/bots\/([\w-]+)\/edu\/proposals\/([^/]+)$/);
    const crew = path.match(/^\/api\/edu\/crew\/([a-f0-9-]{36})(\/cancel)?$/i);
    if (crew) {
      if (method !== (crew[2] ? "POST" : "GET")) return json(res, 405, { error: "method not allowed" });
      if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner or a workspace admin can see Edu crew jobs." });
      if (!crew[2]) {
        const details = deps.crew.details(crew[1]!);
        return details ? json(res, 200, details) : json(res, 404, { error: "No such Edu crew job." });
      }
      const cancelled = await deps.crew.cancelFor(crew[1]!);
      return cancelled.ok ? json(res, 200, cancelled.line) : json(res, cancelled.status, { error: cancelled.error });
    }
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
        ...(status.brokenFolder ? { brokenFolder: true } : {}), ...(status.personalBrain === false ? { personalBrain: false } : {}),
        ...(status.state === "ready" || (bot.eduBrain?.mode === "cloud" && status.state !== "off")
          ? await deps.proposals.view(bot, deps.proposals.rights(auth).mayApprove) : { proposals: [], mayApprove: false }),
        ...(crewOffered(bot, status) ? { crew: await deps.crew.view(bot) } : {}),
      };
      return json(res, 200, body);
    }
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readBody(req);
    const action = body && typeof body === "object" ? (body as { action?: unknown }).action : undefined;
    if (action !== "approve" && action !== "reject") return json(res, 400, { error: "action must be approve or reject" });
    if (!bot) return json(res, 404, { error: "no such bot" });
    const refusal = eduDecisionRefusal(auth, deps.desktop, action === "approve" || bot.eduBrain?.mode === "cloud");
    if (refusal) return json(res, 403, { error: refusal });
    let id: string;
    try { id = decodeURIComponent(decide![2]); } catch { return json(res, 400, { error: "That isn't an Edu proposal id." }); }
    const result = await deps.proposals.decideFor(bot, id, action === "approve");
    return result.ok ? json(res, 200, result) : json(res, result.status, { error: result.error });
  };
}
