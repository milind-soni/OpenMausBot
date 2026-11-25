import type { BotLibrary } from "../../shared/bot-library.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import { collectBotLibrary, type BotLibraryRows } from "../bot-library.ts";
import type { PublishedPageRecord } from "../pages/store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotLibraryRouteDeps {
  bot(id: string): { id: string; threadId: string; tasks?: ReadonlyArray<{ threadId: string }> } | null | undefined;
  /** The same filter the GET /api/bots listing applies to this caller. */
  visibleFor(auth: RequestAuth): Pick<VisibleSet, "bot" | "thread">;
  pages(): readonly PublishedPageRecord[];
  rows?: BotLibraryRows;
}

const LIBRARY = /^\/api\/bots\/([\w-]+)\/library$/;

/** GET /api/bots/:id/library: the pages, apps and files the bot made in all of its conversations (shared/bot-library.ts).
 * Security: only conversations this viewer can read are searched, so on a Team Cloud another person's private
 * conversation names nothing here; a bot they cannot see reads as one that does not exist. */
export function createBotLibraryRoutes(deps: BotLibraryRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    const match = method === "GET" ? LIBRARY.exec(path) : null;
    if (!match) return PASS;
    const bot = deps.bot(match[1]!), visible = deps.visibleFor(auth);
    if (!bot || !visible.bot(bot.id)) return json(res, 404, { error: "no such bot" });
    const threadIds = [...new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)])].filter((threadId) => visible.thread(threadId));
    return json(res, 200, collectBotLibrary({ botId: bot.id, threadIds, pages: deps.pages(), ...(deps.rows ? { rows: deps.rows } : {}) }) satisfies BotLibrary);
  };
}
