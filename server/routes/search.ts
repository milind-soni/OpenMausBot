// The transcript search HTTP route, extracted verbatim from index.ts's
// dispatch chain. Path matching, methods, and status codes are unchanged;
// the handler returns false for anything it does not own so the chain falls
// through in the same order.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, type RouteContext } from "./http.ts";
import { searchMessages } from "../message-db.ts";
import { store } from "../runtime.ts";

export async function handleSearch(_req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> {
  const { method, path, url } = rctx;
  // ── search across every transcript ──────────────────────────────────
  // A LIKE scan over the SQLite message store: local transcripts are
  // megabytes at most, so a scan answers in milliseconds and needs no
  // index to maintain. Hits resolve to the bot/room that owns the thread;
  // rows belonging to deleted conversations resolve to nothing and drop.
  if (method === "GET" && path === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit ? Math.min(Math.max(Number(rawLimit) || 0, 1), 100) : 40;
    const threadId = url.searchParams.get("threadId")?.trim() || undefined;
    if (threadId && !store.botByThread(threadId) && !store.groupByThread(threadId)) {
      json(res, 404, { error: "no such conversation" });
      return true;
    }
    // whether each hit sits on its thread's visible branch — a click on
    // one that does not has to switch versions first (and only then)
    const activePaths = new Map<string, Set<string>>();
    const onActivePath = (threadId: string, messageId: string) => {
      let ids = activePaths.get(threadId);
      if (!ids) activePaths.set(threadId, (ids = new Set(store.activePath(threadId).map((m) => m.id))));
      return ids.has(messageId);
    };
    const hits = searchMessages(q, limit, threadId)
      .map((hit) => {
        const bot = store.botByThread(hit.threadId);
        const group = bot ? undefined : store.groupByThread(hit.threadId);
        if (!bot && !group) return null;
        const active = onActivePath(hit.threadId, hit.messageId);
        if (bot) {
          const task = store.taskByThread(bot.id, hit.threadId);
          return { ...hit, botId: bot.id, name: bot.name, task: task?.title, onActivePath: active };
        }
        if (group) {
          const task = store.groupTaskByThread(group.id, hit.threadId);
          return { ...hit, groupId: group.id, name: group.name, task: task?.title, onActivePath: active };
        }
        return null;
      })
      .filter((hit): hit is NonNullable<typeof hit> => hit !== null);
    json(res, 200, { hits });
    return true;
  }
  return false;
}
