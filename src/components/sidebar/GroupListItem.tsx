import { useEffect, useState } from "react";
import { ChevronRight, Plus, Users } from "lucide-react";
import { formatTime, useStore, type Bot, type Group } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { sidebarGoalRunPreview } from "@/lib/sidebar-layout";
import { BotAvatar } from "../Avatar";
import { SidebarThreadRow, visibleSidebarThreads } from "../SidebarThreadRow";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { useRevealedThreadRow } from "./useRevealedThreadRow";

function groupPreview(group: Group, bots: Bot[]): string {
  if (group.busyBotId) {
    return t("sidebar.preview.botWorking", {
      name: bots.find((b) => b.id === group.busyBotId)?.name ?? t("sidebar.preview.aBot"),
    });
  }
  if (group.working) return t("sidebar.preview.teamWorking");
  const last = group.messages.at(-1);
  if (!last) return t("sidebar.preview.noMessages");
  const text = last.kind === "activity" && last.tool
    ? last.tool.name
    : last.kind === "goal.run" && last.goalRun
      ? sidebarGoalRunPreview(last.goalRun)
      : (last.text ?? "");
  if (last.role === "user") return t("sidebar.preview.you", { text });
  return last.from ? `${last.from.name}: ${text}` : text;
}

/** A small member stack identifies a group without turning it into a card. */
function StackedMauses({ members, density }: { members: Bot[]; density: SidebarDensity }) {
  const iconOnly = density === "icons";
  const slotSize = iconOnly ? "size-12" : density === "compact" ? "size-7" : "size-8";
  const singleSize = iconOnly ? 44 : density === "compact" ? 26 : 32;
  if (members.length <= 1) {
    const b = members[0];
    return (
      <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
        {b ? <BotAvatar bot={b} state="happy" size={singleSize} animated={false} /> : <Users size={24} className="text-ink-secondary" />}
      </div>
    );
  }
  const shown = members.slice(0, 2);
  const extra = members.length - shown.length;
  return (
    <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
      <div className="flex items-center -space-x-2.5">
        {shown.map((b) => (
          <BotAvatar key={b.id} bot={b} state="happy" size={iconOnly ? 30 : 20} animated={false} />
        ))}
        {extra > 0 && (
          <span className="z-10 flex size-4 items-center justify-center rounded-full border border-hairline/40 bg-raised text-[9px] font-medium text-ink-secondary">
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}

export function GroupListItem({
  group,
  density,
  query = "",
  onMenu,
}: {
  group: Group;
  density: SidebarDensity;
  query?: string;
  onMenu: (menu: { groupId: string; x: number; y: number }) => void;
}) {
  const { state, dispatch } = useStore();
  const selected = state.activeView === "chat" && state.selectedId === group.id;
  const [threadsOpen, setThreadsOpen] = useState(selected || Boolean(query));
  useEffect(() => { if (selected || query) setThreadsOpen(true); }, [selected, query]);
  const expanded = !group.dm && threadsOpen && density !== "icons";
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
  return (
    <>
    <div className="group relative">
    <button
      data-sidebar-entity={group.id}
      onClick={() => dispatch({ type: "select", id: group.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
      }}
      // the menu must be reachable without a pointer: Shift+F10, and the
      // dedicated ContextMenu key (whose native event carries no useful
      // coordinates) both open it centered on the row
      onKeyDown={(e) => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onMenu({ groupId: group.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      className={cn(
        "relative flex w-full items-center rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
        density === "icons" ? "justify-center px-1 py-1.5" : density === "compact" ? "gap-1.5 py-1 pl-6 pr-2" : "gap-2 py-1.5 pl-6 pr-2",
        selected && !expanded ? "bg-raised/70" : "hover:bg-raised/40",
      )}
      title={density === "icons" ? group.name : undefined}
      aria-label={density === "icons" ? `${group.name}${group.unread ? ` · ${t("task.unread")}` : ""}` : !expanded && group.unread ? `${group.name} · ${t("task.unread")}` : undefined}
    >
      <StackedMauses members={members} density={density} />
      <div className={cn("min-w-0 flex-1", density === "icons" && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[14px] font-semibold text-ink">{group.name}</span>
          {selected && last && !expanded && <span className="shrink-0 text-[10px] text-ink-secondary">{formatTime(last.at)}</span>}
          {expanded && group.unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unreadMany")} />}
        </div>
        {!expanded && <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-ink-secondary">{groupPreview(group, state.bots)}</span>
          {group.unread && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent" />}
        </div>}
      </div>
      {density === "icons" && group.unread && (
        <span aria-hidden="true" className="absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
    </button>
    {!group.dm && density !== "icons" && <button type="button" aria-label={t(expanded ? "task.collapseNamed" : "task.expandNamed", { name: group.name })} aria-expanded={expanded}
      onClick={() => setThreadsOpen((open) => !open)} className="absolute left-0.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-ink-secondary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60">
      <ChevronRight aria-hidden="true" size={12} className={cn("transition-transform", expanded && "rotate-90")} />
    </button>}
    </div>
    {expanded && <GroupThreadList group={group} selected={selected} density={density} query={group.name.toLowerCase().includes(query.toLowerCase()) ? "" : query} />}
    </>
  );
}

export function GroupThreadList({ group, selected, density = "comfortable", query = "" }: { group: Group; selected: boolean; density?: SidebarDensity; query?: string }) {
  const { state, dispatch } = useStore();
  const [showAll, setShowAll] = useState(false);
  const busy = Boolean(group.working || group.busyBotId);
  const waiting = state.bots.find((bot) => bot.id === group.busyBotId)?.activity === "waiting-on-you";
  const tasks = (group.tasks ?? [{ threadId: group.threadId, title: group.name, createdAt: group.createdAt }]).map((task) => ({
    ...task, busy: task.threadId === group.threadId && busy, unread: task.threadId === group.threadId && group.unread,
    activity: task.threadId === group.threadId && waiting ? "waiting-on-you" as const : undefined,
  }));
  const visible = visibleSidebarThreads(tasks, group.threadId, query, [], showAll);
  useRevealedThreadRow(state.revealThread, selected ? group.threadId : null);
  return <div className="mb-2 ml-5 space-y-0.5 border-l border-hairline/30 pl-2" role="group" aria-label={t("task.namedList", { name: group.name })}>
    {visible.map((task) => <SidebarThreadRow key={task.threadId} task={task} ownerId={group.id} current={selected && task.threadId === group.threadId} compact={density === "compact"}
      onSelect={() => { if (task.threadId !== group.threadId) dispatch({ type: "switchGroupTask", groupId: group.id, threadId: task.threadId }); else dispatch({ type: "select", id: group.id }); }}
      onRename={(title) => dispatch({ type: "renameGroupTask", groupId: group.id, threadId: task.threadId, title })}
      onDelete={() => dispatch({ type: "deleteGroupTask", groupId: group.id, threadId: task.threadId })} />)}
    {!query && !showAll && tasks.length > visible.length && <button type="button" onClick={() => setShowAll(true)} className="px-3 py-1.5 text-[11px] text-ink-secondary hover:text-ink">{t("task.showAll", { count: tasks.length })}</button>}
    <button type="button" disabled={busy} onClick={() => dispatch({ type: "newGroupTask", groupId: group.id })} title={t(busy ? "task.newBusy" : "task.newShort")}
      className="mt-1 flex min-h-8 w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[12px] text-ink-secondary hover:bg-raised/40 hover:text-ink disabled:opacity-40"><Plus size={12} />{t("task.newShort")}</button>
  </div>;
}

