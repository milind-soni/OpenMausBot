// The persistent notification feed: list it, mark one entry or all entries read.
// Admin scope by default, like every route not opened to clients
// (server/request-auth.ts).
//
// GET /api/notifications, POST /api/notifications/read-all, POST /api/notifications/:id/read.
import type { NotificationLogEntry } from "../../shared/notification.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface NotificationRouteDeps {
  /** Newest first. */
  recent(): NotificationLogEntry[];
  markRead(id: string): void;
  markAllRead(): void;
}

/** Builds the handler for the notification feed routes. */
export function createNotificationRoutes(deps: NotificationRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method === "GET" && path === "/api/notifications") {
      return json(res, 200, { notifications: deps.recent() });
    }
    if (method !== "POST") return PASS;
    if (path === "/api/notifications/read-all") {
      deps.markAllRead();
      return json(res, 200, { ok: true });
    }
    const m = path.match(/^\/api\/notifications\/([\w-]+)\/read$/);
    if (!m) return PASS;
    deps.markRead(m[1]);
    return json(res, 200, { ok: true });
  };
}
