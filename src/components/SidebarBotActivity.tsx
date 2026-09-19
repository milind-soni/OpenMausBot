import { BellDot, CircleAlert, Clock3, Loader2 } from "lucide-react";
import { useStore, type Bot, type Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { orderedSidebarThreads } from "./SidebarThreadRow";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

/** Attention is not history browsing: idle conversations never enter this list.
 * Read the sibling's own status, not the bot's aggregate busy/waiting flags. */
export function sidebarBotActivityTasks(bot: Bot, queued: Record<string, unknown[]>): Array<Task & { queued: boolean }> {
  const tasks = bot.tasks ?? [{
    threadId: bot.threadId, title: t("task.newShort"), createdAt: 0,
    busy: bot.busy, activity: bot.activity, unread: bot.unread,
    waitingOnTeammate: bot.waitingOnTeammate,
  }];
  return tasks.map((task) => ({ ...task, queued: Boolean(queued[task.threadId]?.length) }))
    // Routine runs are reachable through their run receipt, never a menu.
    .filter((task) => !task.routineRunId)
    .filter((task) => task.activity === "waiting-on-you" || task.activity === "working" || task.busy || task.waitingOnTeammate === true || task.queued || task.unread);
}

/** One thread that needs the person, from any bot other than the one they
 * are in. Built from the same attention rule and ordering as the sidebar
 * tree, so the bell, the all-threads picker, and the tree itself can never
 * disagree about what needs attention. */
export type AttentionThread = { botId: string; botName: string; task: Task & { queued: boolean } };

export function crossBotAttentionThreads(bots: Bot[], queued: Record<string, unknown[]>, exceptBotId?: string): AttentionThread[] {
  // Flatten first, then order once: sorting each bot on its own would let
  // the unread reply of an earlier bot outrank the waiting approval of a
  // later bot, which the sidebar tree never does. Hidden bots stay out
  // entirely; the archived-bots panel is where they resurface.
  return orderedSidebarThreads(
    bots
      .filter((bot) => bot.id !== exceptBotId && !bot.hidden)
      .flatMap((bot) => sidebarBotActivityTasks(bot, queued)
        .map((task) => ({ ...task, botId: bot.id, botName: bot.name }))),
    "",
  ).map(({ botId, botName, ...task }) => ({ botId, botName, task }));
}

/** The one row shape for attention entries: title, bot name, status, jump.
 * Shared by the sidebar bell and the picker's attention section so both say
 * it the same way. */
export function AttentionThreadRows({ entries, onJump }: { entries: AttentionThread[]; onJump: (entry: AttentionThread) => void }) {
  return <>
    {entries.map((entry) => {
      const waiting = entry.task.activity === "waiting-on-you";
      const teammateWait = !waiting && entry.task.waitingOnTeammate === true;
      const working = !waiting && !teammateWait && (entry.task.busy || entry.task.activity === "working");
      const status = waiting ? t("task.waiting") : working ? t("chat.activity.working") : teammateWait ? t("task.waitingOnTeammate") : entry.task.queued ? t("task.queued") : t("task.unread");
      const label = t("attention.item", { title: entry.task.title, name: entry.botName, status });
      const Icon = waiting ? CircleAlert : working ? Loader2 : teammateWait || entry.task.queued ? Clock3 : BellDot;
      return <button key={`${entry.botId}-${entry.task.threadId}`} type="button" aria-label={label} title={label}
        onClick={() => onJump(entry)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-ink hover:bg-raised/70">
        <Icon size={15} aria-hidden="true" className={cn("shrink-0", working && "animate-spin text-success", waiting && "text-warning", teammateWait && "text-warning")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{entry.task.title}</span>
          <span className="block truncate text-[11px] text-ink-secondary">{entry.botName} · {status}</span>
        </span>
      </button>;
    })}
  </>;
}

/** The escape hatch for other ongoing conversations when their tree is hidden.
 * These are selection-only buttons: no create, rename, move, or delete menu. */
export function SidebarBotActivity({ bot, density }: { bot: Bot; density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const tasks = orderedSidebarThreads(sidebarBotActivityTasks(bot, state.pendingQueued).filter((task) => task.threadId !== bot.threadId), bot.threadId);
  if (!tasks.length) return null;
  const iconOnly = density === "icons";
  return <div data-sidebar-bot-activity={bot.id} className={cn("mb-1 space-y-0.5", !iconOnly && "ml-6")}>
    {tasks.map((task) => {
      const waiting = task.activity === "waiting-on-you";
      const teammateWait = !waiting && task.waitingOnTeammate === true;
      const working = !waiting && !teammateWait && (task.busy || task.activity === "working");
      const status = waiting ? t("sidebar.preview.waiting") : working ? t("chat.activity.working") : teammateWait ? t("sidebar.preview.waitingOnTeammate") : task.queued ? t("task.queued") : t("task.unread");
      const label = `${bot.name}: ${task.title} · ${status}${task.unread && (waiting || working || teammateWait || task.queued) ? ` · ${t("task.unread")}` : ""}`;
      const Icon = waiting ? CircleAlert : working ? Loader2 : teammateWait || task.queued ? Clock3 : BellDot;
      return <button key={task.threadId} type="button" data-sidebar-activity-row={task.threadId} aria-label={label} title={label}
        onClick={() => dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId })}
        className={cn("flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] outline-none hover:bg-raised/50 focus-visible:ring-1 focus-visible:ring-accent/60", iconOnly && "justify-center", waiting ? "text-warning" : "text-ink-secondary")}>
        <Icon size={12} aria-hidden="true" className={cn("shrink-0", working && "animate-spin text-success", teammateWait && "text-warning", task.unread && !waiting && !working && !teammateWait && "text-accent")} />
        {!iconOnly && <><span className="min-w-0 flex-1 truncate">{task.title}</span><span className="shrink-0 text-[10px]">{waiting ? t("task.waiting") : status}</span>
          {task.unread && (waiting || working || teammateWait || task.queued) && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />}</>}
      </button>;
    })}
  </div>;
}
