import { markNotificationLogRead, recentNotificationLog } from "../message-db.ts";
import type { NotificationLogEntry } from "../../shared/notification.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Opening a conversation reads the notifications its opener's list shows, so every open app's badge drops them too. */
export function readThreadNotifications(threadId: string, broadcast: (payload: Record<string, unknown>) => void,
  listed: (entry: NotificationLogEntry) => boolean): void {
  const ids = recentNotificationLog().filter((entry) => entry.threadId === threadId && !entry.read && listed(entry)).map((entry) => entry.id);
  if (!ids.length) return;
  markNotificationLogRead(ids);
  broadcast({ kind: "notifications.read", threadId, ids });
}

/** Whether a notification is in a request's own list. `shown`: on a Team Cloud another person's private chat's
 * notifications are theirs alone, an admin's list included. `reaches`: an ask only its person. */
export function notificationListedFor(shown: (auth: RequestAuth) => (threadId: string) => boolean = () => () => true,
  reaches: (auth: RequestAuth, entry: NotificationLogEntry) => boolean = () => true) {
  return (auth: RequestAuth) => {
    const seen = shown(auth);
    const admin = ownerOrAdmin(auth);
    return (entry: NotificationLogEntry) => (entry.kind !== "spend" || admin) && (!entry.threadId || seen(entry.threadId)) && reaches(auth, entry);
  };
}

export type NotificationListed = ReturnType<typeof notificationListedFor>;

export function createNotificationRoutes(deps = {
  recent: recentNotificationLog,
  markRead: markNotificationLogRead,
}, listed: NotificationListed = notificationListedFor()): RouteHandler {
  const visible = (auth: RequestAuth) => deps.recent().filter(listed(auth));
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
