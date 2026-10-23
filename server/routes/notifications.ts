import { markAllNotificationLogRead, markNotificationLogRead, markThreadNotificationLogRead, recentNotificationLog } from "../message-db.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Opening a conversation reads its notifications, so every open app's badge drops them too. */
export function readThreadNotifications(threadId: string, broadcast: (payload: Record<string, unknown>) => void): void {
  const ids = markThreadNotificationLogRead(threadId);
  if (ids.length) broadcast({ kind: "notifications.read", threadId, ids });
}

/** `shown`: on a Team Cloud another person's private chat's notifications are theirs alone, an admin's list included. */
export function createNotificationRoutes(deps = {
  recent: recentNotificationLog,
  markRead: markNotificationLogRead,
  markAllRead: markAllNotificationLogRead,
}, shown: (auth: RequestAuth) => (threadId: string) => boolean = () => () => true): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    if (method === "GET" && path === "/api/notifications") {
      const seen = shown(auth);
      return json(res, 200, { notifications: deps.recent().filter((entry) => !entry.threadId || seen(entry.threadId)) });
    }
    if (method !== "POST") return PASS;
    if (path === "/api/notifications/read-all") {
      deps.markAllRead();
      return json(res, 200, { ok: true });
    }
    const m = path.match(/^\/api\/notifications\/([\w-]+)\/read$/);
    if (!m) return PASS;
    deps.markRead(m[1]!);
    return json(res, 200, { ok: true });
  };
}
