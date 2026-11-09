import { useEffect, useState } from "react";
import { ChevronRight, Check } from "lucide-react";
import { currentTaskBot, type Action, type Bot } from "@/state/store";
import type { Dispatch } from "react";
import { t } from "@/lib/i18n";
import { localizedTaskTitle } from "@/lib/task-title";
import { useThreadListRequest } from "@/lib/thread-list-navigation";
import { cn } from "@/lib/cn";
import { orderedThreadList } from "./SidebarThreadRow";
import { ThreadStatus } from "./ThreadStatus";

export function CompactBotThreads({ bot, selected, pendingQueued, dispatch }: { bot: Bot; selected: boolean; pendingQueued: Record<string, unknown[]>; dispatch: Dispatch<Action> }) {
  const [open, setOpen] = useState(selected);
  const request = useThreadListRequest(bot.id);
  useEffect(() => { if (selected || request) setOpen(true); }, [selected, request]);
  const tasks = orderedThreadList((bot.tasks ?? []).filter(task => task.threadId === bot.threadId || (!task.routineRunId || task.busy || task.activity === "working")));
  const listId = `bot-thread-list-${bot.id}`;
  return <div className="mb-1 ml-6" data-bot-thread-navigation={bot.id}>
    <button type="button" aria-expanded={open} aria-controls={listId} aria-label={t("thread.toggleNamed", { name: bot.name, count: tasks.length })}
      onClick={() => setOpen(value => !value)} className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-ink-secondary hover:bg-raised/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
      <ChevronRight size={12} aria-hidden="true" className={cn("shrink-0 transition-transform", open && "rotate-90")} />
      <span>{t("task.list")}</span><span className="tabular-nums">{tasks.length}</span>
    </button>
    <nav id={listId} hidden={!open} aria-label={t("task.namedList", { name: bot.name })} className="space-y-0.5">
      {tasks.map(task => {
        const current = selected && task.threadId === bot.threadId;
        const projected = task.threadId === bot.threadId ? currentTaskBot(bot, task.threadId) : task;
        return <button key={task.threadId} type="button" data-agent-thread={task.threadId} aria-current={current ? "page" : undefined}
          onClick={() => dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId })}
          title={localizedTaskTitle(task.title)} className={cn("flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus", current ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/50")}>
          <Check size={12} aria-hidden="true" className={cn("shrink-0 text-accent", !current && "invisible")} />
          <span className="min-w-0 flex-1 truncate text-[12px]">{localizedTaskTitle(task.title)}</span>
          {task.unread && !current && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unread")} />}
          <ThreadStatus task={{ ...task, busy: projected.busy, activity: projected.activity, waitingForTeammates: projected.waitingForTeammates }} queued={Boolean(pendingQueued[task.threadId]?.length)} />
        </button>;
      })}
    </nav>
  </div>;
}
