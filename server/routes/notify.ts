// The script-facing notification route — POST /api/notify — the server
// half of #993's "let local scripts interrupt me" slice. A script that
// already passed the loopback owner gate may ask for the owner's attention
// through the same notify pipeline the harness uses; web push and the
// phone companion remain follow-ups. The handler owns exactly one path
// and returns false for everything else so the chain falls through.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import type { Notification } from "../../shared/notification.ts";

export interface NotifyRoutesDeps {
  notify: (notification: Notification) => void;
  store: {
    bots: { id: string; name: string; threadId: string }[];
    tasks: (botId: string) => { threadId: string }[];
  };
}

export function createNotifyRoutes(deps: NotifyRoutesDeps) {
  const { notify, store } = deps;
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    if (rctx.method !== "POST" || rctx.path !== "/api/notify") return false;
    const body = await readBody(req);
    const title = String(body.title ?? "").trim();
    if (!title) {
      json(res, 400, { error: "title required" });
      return true;
    }
    if (title.length > 200) {
      json(res, 413, { error: "title is limited to 200 characters" });
      return true;
    }
    const bodyText = body.body === undefined || body.body === null ? "" : String(body.body);
    if (bodyText.length > 2000) {
      json(res, 413, { error: "body is limited to 2000 characters" });
      return true;
    }
    const botId = typeof body.botId === "string" ? body.botId : undefined;
    const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
    if (!botId && !threadId) {
      json(res, 400, { error: "botId or threadId required" });
      return true;
    }

    const ownsThread = (bot: { id: string; threadId: string }, thread: string) =>
      bot.threadId === thread || store.tasks(bot.id).some((task) => task.threadId === thread);
    let bot = botId ? store.bots.find((candidate) => candidate.id === botId) : undefined;
    if (botId && !bot) {
      json(res, 404, { error: "unknown bot" });
      return true;
    }
    if (bot && threadId && !ownsThread(bot, threadId)) {
      json(res, 400, { error: "thread does not belong to bot" });
      return true;
    }
    if (!bot) {
      bot = store.bots.find((candidate) => ownsThread(candidate, threadId!));
      if (!bot) {
        json(res, 404, { error: "unknown thread" });
        return true;
      }
    }
    const targetThreadId = threadId ?? bot.threadId;

    // The per-bot notifications toggle exists so the owner can silence what
    // the *harness* judges worth interrupting them with. This route is the
    // owner's own script speaking in the owner's voice — the toggle has no
    // say over it.
    notify({
      kind: "question",
      botId: bot.id,
      botName: bot.name,
      threadId: targetThreadId,
      title,
      body: bodyText,
    });
    json(res, 202, { accepted: true, threadId: targetThreadId });
    return true;
  };
}
