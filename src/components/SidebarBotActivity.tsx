import { BellDot, CircleAlert, Clock3, Loader2 } from "lucide-react";
import { useStore, type Bot, type Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

/** Attention is not history browsing: idle conversations never enter this list.
 * Read the sibling's own status, not the bot's aggregate busy/waiting flags. */
export function sidebarBotActivityTasks(bot: Bot, queued: Record<string, unknown[]>): Array<Task & { queued: boolean }> {
  const tasks = bot.tasks ?? [{
    threadId: bot.threadId, title: t("task.newShort"), createdAt: 0,
    busy: bot.busy, activity: bot.activity, unread: bot.unread,
  }];
  return tasks.map((task) => ({ ...task, queued: Boolean(queued[task.threadId]?.length) }))
    .filter((task) => task.activity === "waiting-on-you" || task.activity === "working" || task.busy || task.queued || task.unread);
}

/** The escape hatch for other ongoing conversations when their tree is hidden.
 * These are selection-only buttons: no create, rename, move, or delete menu. */
export function SidebarBotActivity({ bot, density }: { bot: Bot; density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const tasks = sidebarBotActivityTasks(bot, state.pendingQueued).filter((task) => task.threadId !== bot.threadId);
  if (!tasks.length) return null;
  const iconOnly = density === "icons";
  return <div data-sidebar-bot-activity={bot.id} className={cn("mb-1 space-y-0.5", !iconOnly && "ml-6")}>
    {tasks.map((task) => {
      const waiting = task.activity === "waiting-on-you";
      const working = !waiting && (task.busy || task.activity === "working");
      const status = waiting ? t("sidebar.preview.waiting") : working ? t("chat.activity.working") : task.queued ? t("task.queued") : t("task.unread");
      const label = `${bot.name}: ${task.title} · ${status}${task.unread && (waiting || working || task.queued) ? ` · ${t("task.unread")}` : ""}`;
      const Icon = waiting ? CircleAlert : working ? Loader2 : task.queued ? Clock3 : BellDot;
      return <button key={task.threadId} type="button" data-sidebar-activity-row={task.threadId} aria-label={label} title={label}
        onClick={() => dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId })}
        className={cn("flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] outline-none hover:bg-raised/50 focus-visible:ring-1 focus-visible:ring-accent/60", iconOnly && "justify-center", waiting ? "text-warning" : "text-ink-secondary")}>
        <Icon size={12} aria-hidden="true" className={cn("shrink-0", working && "animate-spin text-success", task.unread && !waiting && !working && "text-accent")} />
        {!iconOnly && <><span className="min-w-0 flex-1 truncate">{task.title}</span><span className="shrink-0 text-[10px]">{waiting ? t("task.waiting") : status}</span>
          {task.unread && (waiting || working || task.queued) && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />}</>}
      </button>;
    })}
  </div>;
}
