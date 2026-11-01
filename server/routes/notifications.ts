import { markNotificationLogRead, markThreadNotificationLogRead, recentNotificationLog } from "../message-db.ts";
import type { NotificationLogEntry } from "../../shared/notification.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Automatic conversation reads keep spend alerts unread unless the opener is an owner or admin. */
export function readThreadNotifications(threadId: string, broadcast: (payload: Record<string, unknown>) => void, auth: RequestAuth): void {
  const ids = markThreadNotificationLogRead(threadId, ownerOrAdmin(auth));
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
    const admin = ownerOrAdmin(auth);
    return deps.recent().filter((entry) => (entry.kind !== "spend" || admin) && (!entry.threadId || seen(entry.threadId)) && reaches(auth, entry));
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
