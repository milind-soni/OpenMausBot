import type { BotLibrary } from "../../shared/bot-library.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import { prepared } from "../message-db.ts";
import type { PublishedPageRecord } from "../pages/store.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotLibraryRouteDeps {
  store: Pick<Store, "bot">;
  visibleFor(auth: RequestAuth): VisibleSet;
  pages(): readonly PublishedPageRecord[];
}

const LIBRARY = /^\/api\/bots\/([\w-]+)\/library$/;
const MAX_APPS = 200;

const BOT_APPS_SQL =
  "SELECT thread_id AS threadId, id AS messageId, json_extract(json, '$.app.title') AS title FROM messages " +
  "WHERE kind = 'app' AND thread_id IN (SELECT value FROM json_each(?)) AND json_extract(json, '$.app.doc') <> '' " +
  "AND (json_extract(json, '$.from.botId') IS NULL OR json_extract(json, '$.from.botId') = ?) " +
  "ORDER BY at DESC, rowid DESC LIMIT ?";

/** GET /api/bots/<id>/library. Security: only the bot's own conversations the caller can read, by the filter that lists
 * its bots and conversations to it, so no row or link from another person's chat or another bot is ever named. */
export function createBotLibraryRoutes(deps: BotLibraryRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    const match = LIBRARY.exec(path);
    if (!match || method !== "GET") return PASS;
    const visible = deps.visibleFor(auth);
    const bot = deps.store.bot(match[1]!);
    if (!bot || !visible.bot(bot.id)) return json(res, 404, { error: "no such bot" });
    const threads = [...new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)])].filter((threadId) => visible.thread(threadId));
    const apps = prepared(BOT_APPS_SQL).all(JSON.stringify(threads), bot.id, MAX_APPS) as BotLibrary["apps"];
    const pages = deps.pages()
      .filter((page) => page.botId === bot.id && !page.uncertain && page.cards.some((card) => threads.includes(card.threadId)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((page) => ({ url: page.url, title: page.title }));
    return json(res, 200, { apps, pages } satisfies BotLibrary);
  };
}
