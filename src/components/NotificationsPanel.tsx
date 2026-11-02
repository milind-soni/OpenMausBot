import { useEffect, useState } from "react";
import { AlertTriangle, AtSign, Bell, CheckCircle2, CircleHelp, HandHelping, Info, LogIn, Newspaper, Pin, RotateCcw, Wallet, X, type LucideIcon } from "lucide-react";
import { api, useStore, openNotificationTarget, type Action } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useShowThreads } from "@/lib/thread-preferences";
import type { LocaleKey } from "@/locales";
import { BotAvatar, type BotAvatarProps } from "./Avatar";
import { threadUpdatedLabel } from "./SidebarThreadRow";
import type { NotificationLogEntry, NotifyKind } from "../../shared/notification";
import { Select } from "./Select";

const KIND_LOOK: Record<NotifyKind, { Icon: LucideIcon; className: string; status: LocaleKey }> = {
  done: { Icon: CheckCircle2, className: "text-success", status: "notifications.status.done" },
  "delegation-settled": { Icon: CheckCircle2, className: "text-success", status: "notifications.status.done" },
  approval: { Icon: HandHelping, className: "text-warning", status: "notifications.status.approval" },
  question: { Icon: CircleHelp, className: "text-warning", status: "notifications.status.question" },
  "sign-in": { Icon: LogIn, className: "text-warning", status: "notifications.status.signIn" },
  mention: { Icon: AtSign, className: "text-accent", status: "notifications.status.mention" },
  incident: { Icon: AlertTriangle, className: "text-danger", status: "notifications.status.incident" },
  "turn-failed": { Icon: AlertTriangle, className: "text-danger", status: "notifications.status.failed" },
  "routine-failed": { Icon: AlertTriangle, className: "text-danger", status: "notifications.status.failed" },
  "routine-deferred": { Icon: RotateCcw, className: "text-accent", status: "notifications.status.deferred" },
  spend: { Icon: Wallet, className: "text-accent", status: "notifications.status.spend" },
  brief: { Icon: Newspaper, className: "text-accent", status: "notifications.status.brief" },
  wait: { Icon: CheckCircle2, className: "text-success", status: "notifications.status.done" },
  notice: { Icon: Info, className: "text-accent", status: "notifications.status.notice" },
};

interface TitledThread { threadId: string; title: string }
interface ThreadLookupState {
  bots: Array<{ id: string; threadId: string; tasks?: TitledThread[] }>;
  groups: Array<{ threadId: string; name: string; tasks?: TitledThread[] }>;
}

export function notificationBotForAvatar<T extends { id: string }>(entry: { botId: string }, bots: T[]): T | null {
  return bots.find((bot) => bot.id === entry.botId) ?? null;
}

/** Null for an unknown or deleted thread, so the row falls back to the stored title. */
export function notificationThreadName(entry: { botId: string; threadId: string }, state: ThreadLookupState): string | null {
  const group = state.groups.find(
    (candidate) => candidate.threadId === entry.threadId || (candidate.tasks ?? []).some((task) => task.threadId === entry.threadId),
  );
  if (group) {
    const task = (group.tasks ?? []).find((candidate) => candidate.threadId === entry.threadId);
    return task?.title || group.name || null;
  }
  const bot = state.bots.find((candidate) => candidate.threadId === entry.threadId || candidate.tasks?.some((task) => task.threadId === entry.threadId));
  const task = bot?.tasks?.find((candidate) => candidate.threadId === entry.threadId);
  return task?.title || null;
}

export const ALL_BOTS = "all";

export function notificationBots(entries: Array<{ botId: string; botName: string }>): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const entry of entries) if (!seen.has(entry.botId)) seen.set(entry.botId, entry.botName);
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function filterNotifications<T extends { botId: string }>(entries: T[], botId: string): T[] {
  return botId === ALL_BOTS ? entries : entries.filter((entry) => entry.botId === botId);
}

export function NotificationRail() {
  const { state, dispatch } = useStore();
  const unread = state.notifications.reduce((count, n) => count + (n.read ? 0 : 1), 0);
  if (state.notificationsOpen) return null;
  return (
    <aside aria-label={t("notifications.title")} className="absolute right-0 top-1/2 z-20 -translate-y-1/2 rounded-l-lg border border-r-0 border-hairline/40 bg-panel p-1 shadow-sm">
      <button
        type="button"
        onClick={() => dispatch({ type: "toggleNotifications" })}
        aria-label={unread > 0 ? t("notifications.railUnread", { count: unread }) : t("notifications.title")}
        title={t("notifications.title")}
        aria-pressed={false}
        className="relative flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <Bell size={17} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-ink">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
    </aside>
  );
}

/** Marks entries read on the server; if that fails, reloads the feed so the UI shows what the server has. */
export async function postNotificationRead(path: string, dispatch: (action: Action) => void): Promise<void> {
  try {
    await api(path, { method: "POST" });
    return;
  } catch {
    // The resync below shows what the server kept.
  }
  try {
    const { notifications } = await api<{ notifications?: unknown }>("/api/notifications");
    if (Array.isArray(notifications)) dispatch({ type: "notificationsHydrated", notifications });
  } catch {
    // Offline: the next hydration corrects the badge.
  }
}

export function NotificationsPanel() {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [now, setNow] = useState(() => Date.now());
  const [botFilter, setBotFilter] = useState(ALL_BOTS);
  const bots = notificationBots(state.notifications);
  const activeFilter = botFilter === ALL_BOTS || bots.some((bot) => bot.id === botFilter) ? botFilter : ALL_BOTS;
  const visible = filterNotifications(state.notifications, activeFilter);
  const unreadCount = state.notifications.reduce((count, n) => count + (n.read ? 0 : 1), 0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const openRow = (entry: NotificationLogEntry) => {
    if (!entry.read) {
      dispatch({ type: "notificationRead", id: entry.id });
      void postNotificationRead(`/api/notifications/${entry.id}/read`, dispatch);
    }
    openNotificationTarget(dispatch, { botId: entry.botId, threadId: entry.threadId }, state, showThreads);
  };

  const markAllRead = () => {
    dispatch({ type: "notificationsMarkAllRead" });
    void postNotificationRead("/api/notifications/read-all", dispatch);
  };

  return (
    <aside
      aria-label={t("notifications.title")}
      className="animate-panel-in flex h-full w-[300px] max-w-full shrink-0 flex-col border-l border-hairline/40 bg-panel max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30"
    >
      <div className="flex items-center gap-1.5 border-b border-hairline/40 px-3.5 py-2.5">
        <span className="flex-1 text-[13px] font-medium text-ink">
          {t("notifications.title")}
          {unreadCount > 0 && <span className="ml-1.5 text-[12px] font-normal text-accent">· {t("notifications.unread", { count: unreadCount })}</span>}
        </span>
        <button type="button" onClick={markAllRead} className="shrink-0 whitespace-nowrap text-[12px] text-accent hover:underline">
          {t("notifications.markAllRead")}
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleNotificationsPinned" })}
          aria-label={state.notificationsPinned ? t("notifications.unpin") : t("notifications.pin")}
          aria-pressed={state.notificationsPinned}
          title={state.notificationsPinned ? t("notifications.unpin") : t("notifications.pin")}
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
          aria-label={t("notifications.close")}
          title={t("notifications.close")}
          className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>
      <div className="border-b border-hairline/40 px-3.5 py-2">
        <Select size="sm" className="w-full"
          aria-label={t("notifications.filter")}
          value={activeFilter}
          onChange={(event) => setBotFilter(event.target.value)}
        >
          <option value={ALL_BOTS}>{t("notifications.allBots")}</option>
          {bots.map((bot) => (
            <option key={bot.id} value={bot.id}>{bot.name}</option>
          ))}
        </Select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 && (
          <div className="px-3.5 py-6 text-[13px] text-ink-secondary">{state.notifications.length === 0 ? t("notifications.empty") : t("notifications.emptyForBot")}</div>
        )}
        {visible.map((entry) => (
          <NotificationRow key={entry.id} entry={entry} now={now} bot={notificationBotForAvatar(entry, state.bots)} threadName={notificationThreadName(entry, state)} onOpen={() => openRow(entry)} />
        ))}
      </div>
      <div className="border-t border-hairline/40 px-3.5 py-2 text-center text-[12px] text-ink-tertiary">
        {t("notifications.retention")}
      </div>
    </aside>
  );
}

function NotificationRow({ entry, now, bot, threadName, onOpen }: { entry: NotificationLogEntry; now: number; bot: BotAvatarProps["bot"] | null; threadName: string | null; onOpen: () => void }) {
  const { Icon, className, status } = KIND_LOOK[entry.kind] ?? KIND_LOOK.done;
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
      {bot ? (
        <span className="mt-px shrink-0" aria-hidden="true"><BotAvatar bot={bot} state="happy" size={24} animated={false} /></span>
      ) : (
        <Icon size={16} aria-hidden="true" className={cn("mt-0.5 shrink-0", className)} />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5 text-[13px] font-medium text-ink">
          {!entry.read && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />}
          {threadName ? (
            <>
              <span className="shrink-0 max-w-[45%] truncate">{entry.botName}</span>
              <span className="shrink-0 text-ink-tertiary" aria-hidden="true">·</span>
              <span className="min-w-0 flex-1 truncate font-normal">{threadName}</span>
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate">{entry.title}</span>
          )}
          <span className={cn("shrink-0 text-[11px] font-medium", className)}>{t(status)}</span>
        </span>
        {entry.body && <span className="mt-0.5 block truncate text-[12px] text-ink-secondary">{entry.body}</span>}
        <span className="mt-0.5 block text-[11px] text-ink-tertiary">{threadUpdatedLabel(entry.at, now)}</span>
      </span>
    </button>
  );
}
