import { markNotificationLogRead, markThreadNotificationLogRead, recentNotificationLog } from "../message-db.ts";
import type { NotificationLogEntry } from "../../shared/notification.ts";
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
}, shown: (auth: RequestAuth) => (threadId: string) => boolean = () => () => true,
  reaches: (auth: RequestAuth, entry: NotificationLogEntry) => boolean = () => true): RouteHandler {
  const visible = (auth: RequestAuth) => {
    const seen = shown(auth);
    return deps.recent().filter((entry) => (!entry.threadId || seen(entry.threadId)) && reaches(auth, entry));
  };
  return async ({ res, path, method, auth, json }) => {
    if (method === "GET" && path === "/api/notifications") {
      return json(res, 200, { notifications: visible(auth) });
    }
    if (method !== "POST") return PASS;
    if (path === "/api/notifications/read-all") {
      const unread = visible(auth).filter((entry) => !entry.read).map((entry) => entry.id);
      if (unread.length) deps.markRead(unread);
      return json(res, 200, { ok: true });
    }
    const m = path.match(/^\/api\/notifications\/([\w-]+)\/read$/);
    if (!m) return PASS;
    if (!visible(auth).some((entry) => entry.id === m[1])) return json(res, 404, { error: "no such notification" });
    deps.markRead([m[1]!]);
    return json(res, 200, { ok: true });
  };
}
