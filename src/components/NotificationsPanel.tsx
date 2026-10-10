// The right-rail notification feed: a scroll-back log of "notify" events,
// independent of the sidebar's own live attention bell (SidebarBotActivity.tsx)
// which only ever shows what is unread or in flight right now. Clicking a
// row reuses the exact same jump as an OS notification click (openNotificationTarget,
// store.tsx) so a stale/unknown thread degrades the same way there too.
import { useEffect, useState } from "react";
import { AlertTriangle, Bell, CheckCircle2, CircleHelp, HandHelping, Pin, RotateCcw, Wallet, X, type LucideIcon } from "lucide-react";
import { useStore, openNotificationTarget } from "@/state/store";
import { cn } from "@/lib/cn";
import type { NotificationLogEntry, NotifyKind } from "../../shared/notification";

/** One icon and tone per NotifyKind — the same four tones ActivityPanel's
 * outcomeChip uses (ok/danger/accent/warn), so a notification reads with
 * the same color vocabulary as the activity log right next to it. */
const KIND_ICON: Record<NotifyKind, { Icon: LucideIcon; className: string }> = {
  done: { Icon: CheckCircle2, className: "text-success" },
  "delegation-settled": { Icon: CheckCircle2, className: "text-success" },
  approval: { Icon: HandHelping, className: "text-warning" },
  question: { Icon: CircleHelp, className: "text-warning" },
  takeover: { Icon: HandHelping, className: "text-warning" },
  incident: { Icon: AlertTriangle, className: "text-danger" },
  "turn-failed": { Icon: AlertTriangle, className: "text-danger" },
  "routine-failed": { Icon: AlertTriangle, className: "text-danger" },
  "routine-deferred": { Icon: RotateCcw, className: "text-accent" },
  spend: { Icon: Wallet, className: "text-accent" },
};

function relativeTime(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/** The always-visible trigger: a single bell, sibling to the Computer/Inspector/
 * Activity panels in App.tsx's flex row, but never gated on a bot being
 * selected — the feed it opens is cross-bot. */
export function NotificationRail() {
  const { state, dispatch } = useStore();
  const unread = state.notifications.reduce((count, n) => count + (n.read ? 0 : 1), 0);
  return (
    <aside aria-label="Notification rail" className="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-hairline/40 bg-panel py-2">
      <button
        type="button"
        onClick={() => dispatch({ type: "toggleNotifications" })}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        title="Notifications"
        aria-pressed={state.notificationsOpen}
        className={cn(
          "relative flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink",
          state.notificationsOpen && "bg-raised text-ink",
        )}
      >
        <Bell size={17} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent px-1 text-[9.5px] font-semibold text-accent-ink">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
    </aside>
  );
}

export function NotificationsPanel() {
  const { state, dispatch } = useStore();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const openRow = (entry: NotificationLogEntry) => {
    if (!entry.read) {
      dispatch({ type: "notificationRead", id: entry.id });
      fetch(`/api/notifications/${entry.id}/read`, { method: "POST" }).catch(() => {});
    }
    openNotificationTarget(dispatch, { botId: entry.botId, threadId: entry.threadId }, state);
  };

  const markAllRead = () => {
    dispatch({ type: "notificationsMarkAllRead" });
    fetch("/api/notifications/read-all", { method: "POST" }).catch(() => {});
  };

  return (
    <aside
      aria-label="Notifications"
      className="animate-panel-in flex h-full w-[300px] max-w-full shrink-0 flex-col border-l border-hairline/40 bg-panel max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30"
    >
      <div className="flex items-center gap-1.5 border-b border-hairline/40 px-3.5 py-2.5">
        <span className="flex-1 text-[13px] font-medium text-ink">Notifications</span>
        <button type="button" onClick={markAllRead} className="shrink-0 whitespace-nowrap text-[11.5px] text-accent hover:underline">
          Mark all read
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleNotificationsPinned" })}
          aria-label={state.notificationsPinned ? "Unpin Notifications" : "Pin Notifications open"}
          aria-pressed={state.notificationsPinned}
          title={state.notificationsPinned ? "Unpin" : "Pin open"}
          className={cn(
            "flex size-[26px] shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink",
            state.notificationsPinned && "text-accent",
          )}
        >
          <Pin size={14} />
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleNotifications", open: false })}
          aria-label="Close Notifications"
          title="Close Notifications"
          className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.notifications.length === 0 && (
          <div className="px-3.5 py-6 text-[13px] text-ink-secondary">Nothing yet.</div>
        )}
        {state.notifications.map((entry) => (
          <NotificationRow key={entry.id} entry={entry} now={now} onOpen={() => openRow(entry)} />
        ))}
      </div>
      <div className="border-t border-hairline/40 px-3.5 py-2 text-center text-[11.5px] text-ink-tertiary">
        Last 500 events, newest first
      </div>
    </aside>
  );
}

function NotificationRow({ entry, now, onOpen }: { entry: NotificationLogEntry; now: number; onOpen: () => void }) {
  const { Icon, className } = KIND_ICON[entry.kind];
  return (
    <button
      type="button"
      onClick={onOpen}
      title={entry.title}
      className={cn(
        "flex w-full gap-2.5 border-b border-hairline/20 px-3.5 py-2.5 text-left hover:bg-raised/60",
        !entry.read && "bg-accent/5",
      )}
    >
      <Icon size={16} aria-hidden="true" className={cn("mt-0.5 shrink-0", className)} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5 text-[12.5px] font-medium text-ink">
          {!entry.read && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />}
          <span className="truncate">{entry.title}</span>
        </span>
        {entry.body && <span className="mt-0.5 block truncate text-[12px] text-ink-secondary">{entry.body}</span>}
        <span className="mt-0.5 block text-[11px] text-ink-tertiary">{relativeTime(entry.at, now)}</span>
      </span>
    </button>
  );
}
