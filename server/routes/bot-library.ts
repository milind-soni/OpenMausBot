import { z } from "zod";

import { BOT_LIBRARY_REMOVE_MAX, type BotLibrary } from "../../shared/bot-library.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import { collectBotLibrary, type BotLibraryRows } from "../bot-library.ts";
import { dropStoredCopies, LIBRARY_PATH_MAX, type LibraryRemovals, type StoredCopies } from "../bot-library-removed.ts";
import type { PublishedPageRecord } from "../pages/store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotLibraryRouteDeps {
  bot(id: string): { id: string; threadId: string; tasks?: ReadonlyArray<{ threadId: string }> } | null | undefined;
  /** The same filter the GET /api/bots listing applies to this caller. */
  visibleFor(auth: RequestAuth): Pick<VisibleSet, "bot" | "thread">;
  pages(): readonly PublishedPageRecord[];
  rows?: BotLibraryRows;
  removals: Pick<LibraryRemovals, "list" | "add">;
  copies: StoredCopies;
}

const LIBRARY = /^\/api\/bots\/([\w-]+)\/library(\/remove)?$/;
const removeBody = z.object({ paths: z.array(z.string().min(1).max(LIBRARY_PATH_MAX)).min(1).max(BOT_LIBRARY_REMOVE_MAX) });

/** GET /api/bots/:id/library: the pages, apps and files the bot made in all of its conversations (shared/bot-library.ts).
 * POST /api/bots/:id/library/remove takes files out of it (BotLibraryRemove).
 * Security: only conversations this viewer can read are searched, so on a Team Cloud another person's private
 * conversation names nothing here; a bot they cannot see reads as one that does not exist. */
export function createBotLibraryRoutes(deps: BotLibraryRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = LIBRARY.exec(path);
    const remove = Boolean(match?.[2]);
    if (!match || method !== (remove ? "POST" : "GET")) return PASS;
    const bot = deps.bot(match[1]!), visible = deps.visibleFor(auth);
    if (!bot || !visible.bot(bot.id)) return json(res, 404, { error: "no such bot" });
    const threadIds = [...new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)])].filter((threadId) => visible.thread(threadId));
    if (!remove) {
      const library = collectBotLibrary({ botId: bot.id, threadIds, pages: deps.pages(), ...(deps.rows ? { rows: deps.rows } : {}) });
      return json(res, 200, { ...library, removed: deps.removals.list(bot.id) } satisfies BotLibrary);
    }
    const parsed = removeBody.safeParse(await readBody(req, 4 * 1024 * 1024).catch(() => null));
    if (!parsed.success) return json(res, 400, { error: "Name the files to remove." });
    const removed = deps.removals.add(bot.id, parsed.data.paths);
    dropStoredCopies(parsed.data.paths, new Set(threadIds), deps.copies);
    return json(res, 200, { removed });
  };
}
