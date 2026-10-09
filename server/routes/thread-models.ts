// "Switch them too": a bot's threads that run on a model of their own,
// different from the bot's, follow the bot's model again. A one-time action
// beside the bot's model setting, not a setting. Admin scope by default
// (server/request-auth.ts), like the bot's model itself.
//
// POST /api/bots/:id/threads/follow-model, body {} for every such thread, or
// { threadIds } for exactly those, each one of this bot's. A thread with a
// turn running keeps its model until it settles; the reply counts it.
import type { ModelSelection } from "../contracts.ts";
import type { RequestAuth } from "../request-auth.ts";
import { sameModelSelection } from "../../shared/thread-model.ts";
import { PASS, type RouteHandler } from "./table.ts";

const MAX_THREAD_IDS = 10_000;

export interface ThreadModelRouteDeps {
  bot(id: string): {
    id: string;
    modelSelection: ModelSelection;
    approvalGrant?: unknown;
    tasks?: ReadonlyArray<{ threadId: string; modelSelection?: ModelSelection }>;
  } | null | undefined;
  /** A turn is running in this thread. */
  busy(botId: string, threadId: string): boolean;
  /** Clears these threads' own model in one write (Store.followBotModel). */
  follow(botId: string, threadIds: string[]): string[];
  /** Whoever may change this bot's model: on a Cloud home, only its owner. */
  mayChangeModel(auth: RequestAuth): boolean;
  /** The bot as the reply carries it. */
  reply(botId: string): unknown;
}

export function createThreadModelRoutes(deps: ThreadModelRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/threads\/follow-model$/);
    if (!m || method !== "POST") return PASS;
    const bot = deps.bot(m[1]!);
    if (!bot) return json(res, 404, { error: "no such bot" });
    if (!deps.mayChangeModel(auth)) return json(res, 403, { error: "On this Cloud only its owner can change a bot's model." });
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "threadIds")) {
      return json(res, 400, { error: "send {} or { threadIds }" });
    }
    const raw: unknown = body.threadIds;
    if (raw !== undefined && (!Array.isArray(raw) || raw.length > MAX_THREAD_IDS || raw.some((id) => typeof id !== "string"))) {
      return json(res, 400, { error: "threadIds must be a list of this bot's thread ids" });
    }
    const tasks = bot.tasks ?? [];
    const ids = new Set(tasks.map((task) => task.threadId));
    const foreign = (raw as string[] | undefined)?.find((id) => !ids.has(id));
    if (foreign !== undefined) return json(res, 400, { error: `"${foreign}" is not one of this bot's threads` });
    if (bot.approvalGrant) return json(res, 409, { error: "wait for the approval-level change to finish before changing models" });
    const listed = raw === undefined ? null : new Set(raw as string[]);
    const own = tasks.filter((task) => (!listed || listed.has(task.threadId)) &&
      task.modelSelection !== undefined && !sameModelSelection(task.modelSelection, bot.modelSelection));
    const busy = own.filter((task) => deps.busy(bot.id, task.threadId));
    const switched = deps.follow(bot.id, own.filter((task) => !busy.includes(task)).map((task) => task.threadId));
    return json(res, 200, { switched: switched.length, busy: busy.length, bot: deps.reply(bot.id) });
  };
}
