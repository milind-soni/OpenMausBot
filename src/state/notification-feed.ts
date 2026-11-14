import type { NotificationLogEntry } from "../../shared/notification";

export const NOTIFICATION_FEED_LIMIT = 500;

export type NotificationFeedAction =
  | { type: "notificationsHydrated"; notifications: NotificationLogEntry[] }
  | { type: "notificationReceived"; entry: NotificationLogEntry }
  | { type: "notificationRead"; id: string }
  | { type: "notificationsRead"; ids: string[] }
  | { type: "notificationsMarkAllRead" };

const FEED_ACTIONS: ReadonlySet<string> = new Set<NotificationFeedAction["type"]>([
  "notificationsHydrated", "notificationReceived", "notificationRead", "notificationsRead", "notificationsMarkAllRead",
]);

/** The feed's own actions, which the app's reducer hands straight to reduceNotificationFeed. */
export function isNotificationFeedAction(action: { type: string }): action is NotificationFeedAction {
  return FEED_ACTIONS.has(action.type);
}

/** Newest first. Hydration takes the server's copy of each entry it returns and keeps live entries it has not seen yet. */
export function reduceNotificationFeed(feed: NotificationLogEntry[], action: NotificationFeedAction): NotificationLogEntry[] {
  switch (action.type) {
    case "notificationsHydrated": {
      const served = new Set(action.notifications.map((entry) => entry.id));
      return [...feed.filter((entry) => !served.has(entry.id)), ...action.notifications]
        .sort((a, b) => b.at - a.at)
        .slice(0, NOTIFICATION_FEED_LIMIT);
    }
    case "notificationReceived":
      return feed.some((entry) => entry.id === action.entry.id) ? feed : [action.entry, ...feed].slice(0, NOTIFICATION_FEED_LIMIT);
    case "notificationRead":
      return feed.map((entry) => (entry.id === action.id && !entry.read ? { ...entry, read: true } : entry));
    case "notificationsRead": {
      const ids = new Set(action.ids);
      return feed.map((entry) => (ids.has(entry.id) && !entry.read ? { ...entry, read: true } : entry));
    }
    case "notificationsMarkAllRead":
      return feed.map((entry) => (entry.read ? entry : { ...entry, read: true }));
  }
}
