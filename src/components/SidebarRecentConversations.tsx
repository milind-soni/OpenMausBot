import { useMemo, useState } from "react";
import { useStoreSelector } from "@/state/store-select";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { hiddenFromSidebar } from "@/lib/default-bot";
import { t } from "@/lib/i18n";
import { isPlaceId } from "@/lib/place-chat";
import { localizedTaskTitle } from "@/lib/task-title";
import type { AppState, Bot, Group } from "@/state/store";
import type { ThreadTarget } from "@/state/thread-navigation";
import { rowSelectedSurface } from "./SidebarRowMarkers";
import { isArchived, threadRecency } from "./SidebarThreadRow";

const ROW_CLASS = "flex min-h-8 w-full items-center gap-1.5 rounded-md px-2 text-left leading-[18px] hover:bg-ink/[0.06] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus max-md:min-h-11";

export function SidebarRecentConversations({ bots, groups, routineRuns, viewerEmail, welcoming, selectedId, onOpen }: {
  bots: Bot[];
  groups: Group[];
  routineRuns: AppState["routineRuns"];
  viewerEmail: string | null | undefined;
  welcoming: string | null;
  selectedId: string | null;
  onOpen: (target: ThreadTarget) => void;
}) {
  const openRoomThread = useStoreSelector((state) => state.forkPanel?.kind === "group" && state.forkPanel.ownerId === selectedId ? state.forkPanel.threadId : null);
  const [expanded, setExpanded] = useState(true);
  const entries = useMemo(() => {
    const runThreads = new Set(routineRuns?.map((run) => run.threadId));
    const botEntries = bots.filter((bot) => !bot.hidden && !isPlaceId(bot.id) && bot.id !== welcoming && !hiddenFromSidebar(bot, viewerEmail))
      .flatMap((owner) => (owner.tasks ?? [{ threadId: owner.threadId, title: owner.title, createdAt: 0, updatedAt: owner.messages.at(-1)?.at }])
        .filter((task) => !task.routineRunId).map((task) => ({ owner, task })));
    const roomEntries = groups.flatMap((owner) => (owner.tasks ?? [{ threadId: owner.threadId, title: owner.name, createdAt: owner.createdAt, updatedAt: owner.messages.at(-1)?.at }])
      .map((task) => ({ owner, task })));
    return [...botEntries, ...roomEntries]
      .filter(({ task }) => !isArchived(task) && !runThreads.has(task.threadId))
      .map((entry) => ({ ...entry, at: entry.task.lastThreadOrderAt ?? threadRecency(entry.task) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 6);
  }, [bots, groups, routineRuns, viewerEmail, welcoming]);
  if (!entries.length) return null;

  const label = t("sidebar.section.recentConversations");
  return <section aria-label={label} data-sidebar-recent="" className="mb-1">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}
      className={cn(ROW_CLASS, "text-[13px] text-ink-secondary hover:text-ink")}>
      <ChevronRight size={12} aria-hidden="true" className={cn("shrink-0 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
      <span className="truncate">{label}</span>
    </button>
    {expanded && entries.map(({ owner, task }) => {
      const current = selectedId === owner.id && task.threadId === (openRoomThread ?? owner.threadId);
      const title = task.title ? localizedTaskTitle(task.title) : t("task.untitledChat");
      return <button key={`${owner.id}:${task.threadId}`} type="button" data-sidebar-recent-thread={task.threadId}
        aria-current={current ? "page" : undefined} title={`${title} · ${owner.name}`}
        onClick={() => onOpen({ botId: owner.id, threadId: task.threadId })}
        className={cn(ROW_CLASS, "ps-6 text-[13px] text-ink", current && rowSelectedSurface)}>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="max-w-[40%] truncate text-[12px] text-ink-secondary">{owner.name}</span>
      </button>;
    })}
  </section>;
}
