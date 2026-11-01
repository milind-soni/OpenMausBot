import { BellDot, CircleAlert, Clock3, Loader2, Pin, PinOff, type LucideIcon } from "lucide-react";
import type { Dispatch } from "react";
import type { Action, AppState, Bot, Group, Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { roomThreadSpeakerId, roomThreadWorking } from "@/lib/room-threads";
import { t } from "@/lib/i18n";
import { isArchived, orderedSidebarThreads, orderedThreadList, threadRecency, threadUpdatedLabel } from "./SidebarThreadRow";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { localizedTaskTitle } from "@/lib/task-title";

export function sidebarBotActivityTasks(bot: Bot, queued: Record<string, unknown[]>, archivedApprovals = false): Array<Task & { queued: boolean }> {
  const tasks = bot.tasks ?? [{
    threadId: bot.threadId, title: t("task.newShort"), createdAt: 0,
    busy: bot.busy, activity: bot.activity, unread: bot.unread,
    waitingForTeammates: bot.waitingForTeammates,
  }];
  return tasks.map((task) => ({ ...task, queued: Boolean(queued[task.threadId]?.length) }))
    .filter((task) => !task.routineRunId)
    .filter((task) => !isArchived(task) || (archivedApprovals && task.activity === "waiting-on-you"))
    .filter((task) => task.activity === "waiting-on-you" || task.activity === "working" || task.busy || task.waitingForTeammates === true || task.queued || task.unread);
}

export function sidebarBotStatus(bot: Bot, queued: Record<string, unknown[]>) {
  const tasks = sidebarBotActivityTasks(bot, queued);
  const waiting = bot.activity === "waiting-on-you" || tasks.some((task) => task.activity === "waiting-on-you");
  const working = !waiting && (Boolean(bot.busy) || tasks.some((task) => task.busy || task.activity === "working"));
  const teammateWait = !waiting && !working && (Boolean(bot.waitingForTeammates) || tasks.some((task) => Boolean(task.waitingForTeammates)));
  return { waiting, working, teammateWait, queued: tasks.some((task) => task.queued) };
}

export function threadsWhenTreeHidden(bot: Bot, queued: Record<string, unknown[]>) {
  const attention = sidebarBotActivityTasks(bot, queued);
  const seen = new Set(attention.map((task) => task.threadId));
  const pinned = (bot.tasks ?? [])
    .filter((task) => task.pinned === true && !task.routineRunId && !seen.has(task.threadId))
    .map((task) => ({ ...task, queued: Boolean(queued[task.threadId]?.length) }));
  return orderedThreadList([...attention, ...pinned]);
}

/** Must derive each thread's state exactly as GroupThreadList's sidebar rows do. */
export function sidebarGroupActivityTasks(group: Group, bots: Bot[], queued: Record<string, unknown[]>): Array<Task & { queued: boolean }> {
  if (group.dm) return [];
  const tasks = (group.tasks ?? [{ threadId: group.threadId, title: group.name, createdAt: group.createdAt }]).map((task) => {
    const speakerId = roomThreadSpeakerId(group, task.threadId);
    const waiting = Boolean(speakerId) && bots.find((bot) => bot.id === speakerId)?.activity === "waiting-on-you";
    return {
      ...task, busy: roomThreadWorking(group, task.threadId), unread: task.threadId === group.threadId && Boolean(group.unread),
      activity: waiting ? "waiting-on-you" as const : undefined,
    };
  });
  return tasks.map((task) => ({ ...task, queued: Boolean(queued[task.threadId]?.length) }))
    .filter((task) => task.activity === "waiting-on-you" || task.busy || task.queued || task.unread);
}

export type AttentionThread =
  | { kind: "bot"; botId: string; botName: string; task: Task & { queued: boolean } }
  | { kind: "group"; groupId: string; groupName: string; groupThreadId: string; task: Task & { queued: boolean } };

export function attentionOwnerName(entry: AttentionThread): string {
  return entry.kind === "bot" ? entry.botName : entry.groupName;
}

export function attentionJumpAction(entry: AttentionThread):
  | { type: "switchTask"; botId: string; threadId: string }
  | { type: "switchGroupTask"; groupId: string; threadId: string }
  | { type: "select"; id: string } {
  if (entry.kind === "bot") return { type: "switchTask", botId: entry.botId, threadId: entry.task.threadId };
  return entry.task.threadId === entry.groupThreadId
    ? { type: "select", id: entry.groupId }
    : { type: "switchGroupTask", groupId: entry.groupId, threadId: entry.task.threadId };
}

export function attentionUnpinAction(entry: AttentionThread):
  | { type: "updateTask"; botId: string; threadId: string; patch: { pinned: boolean } }
  | { type: "pinGroupTask"; groupId: string; threadId: string; pinned: boolean; title: string } {
  if (entry.kind === "bot") return { type: "updateTask", botId: entry.botId, threadId: entry.task.threadId, patch: { pinned: false } };
  return { type: "pinGroupTask", groupId: entry.groupId, threadId: entry.task.threadId, pinned: false, title: entry.task.title };
}

/** aria-label replaces the button's contents, so the count must be in the name or a screen reader never hears it. */
export function attentionTriggerLabel(count: number): string {
  return count > 0 ? t("attention.titleCount", { count }) : t("attention.title");
}

export function attentionHasRunningWork(entries: readonly AttentionThread[]): boolean {
  return entries.some((entry) => entry.task.activity === "working" || (entry.task.busy === true && entry.task.activity !== "waiting-on-you") || entry.task.queued === true);
}

export function attentionRowStatus(task: AttentionThread["task"]): { active: boolean; Icon: LucideIcon; colorClass: string; label: string } {
  const waiting = task.activity === "waiting-on-you";
  const teammateWait = !waiting && task.waitingForTeammates === true;
  const working = !waiting && !teammateWait && (task.busy || task.activity === "working");
  const active = waiting || teammateWait || working || task.queued || task.unread === true;
  const label = waiting ? t("task.waiting") : working ? t("chat.activity.working") : teammateWait ? t("task.waitingOnTeammate") : task.queued ? t("task.queued") : t("task.unread");
  const Icon = waiting ? CircleAlert : working ? Loader2 : teammateWait || task.queued ? Clock3 : BellDot;
  const colorClass = cn(working && "animate-spin text-success", (waiting || teammateWait) && "text-warning");
  return { active, Icon, colorClass, label };
}

type FlatAttentionEntry = Task & {
  queued: boolean; botId?: string; botName?: string; groupId?: string; groupName?: string; groupThreadId?: string;
};

export function crossBotAttentionThreads(
  bots: Bot[], queued: Record<string, unknown[]>, exceptBotId?: string, groups: Group[] = [],
): AttentionThread[] {
  const flat: FlatAttentionEntry[] = [
    ...bots
      .filter((bot) => bot.id !== exceptBotId && !bot.hidden)
      .flatMap((bot): FlatAttentionEntry[] => sidebarBotActivityTasks(bot, queued, true)
        .map((task) => ({ ...task, botId: bot.id, botName: bot.name }))),
    ...groups
      .flatMap((group): FlatAttentionEntry[] => sidebarGroupActivityTasks(group, bots, queued)
        .map((task) => ({ ...task, groupId: group.id, groupName: group.name, groupThreadId: group.threadId }))),
  ];
  return orderedSidebarThreads(flat, "").map(({ botId, botName, groupId, groupName, groupThreadId, ...task }): AttentionThread =>
    groupId !== undefined
      ? { kind: "group", groupId, groupName: groupName!, groupThreadId: groupThreadId!, task }
      : { kind: "bot", botId: botId!, botName: botName!, task });
}

export function crossBotPinnedThreads(bots: Bot[], groups: Group[], queued: Record<string, unknown[]>): AttentionThread[] {
  const flat: FlatAttentionEntry[] = [
    ...bots
      .filter((bot) => !bot.hidden)
      .flatMap((bot): FlatAttentionEntry[] => (bot.tasks ?? [])
        .filter((task) => task.pinned === true && !task.routineRunId)
        .map((task) => ({ ...task, queued: Boolean(queued[task.threadId]?.length), botId: bot.id, botName: bot.name }))),
    ...groups
      .flatMap((group): FlatAttentionEntry[] => {
        const activity = new Map(sidebarGroupActivityTasks(group, bots, queued).map((task) => [task.threadId, task]));
        return (group.tasks ?? [])
          .filter((task) => task.pinned === true)
          .map((task) => ({ ...task, ...activity.get(task.threadId), queued: Boolean(queued[task.threadId]?.length), groupId: group.id, groupName: group.name, groupThreadId: group.threadId }));
      }),
  ];
  return orderedThreadList(flat).map(({ botId, botName, groupId, groupName, groupThreadId, ...task }): AttentionThread =>
    groupId !== undefined
      ? { kind: "group", groupId, groupName: groupName!, groupThreadId: groupThreadId!, task }
      : { kind: "bot", botId: botId!, botName: botName!, task });
}

export function AttentionThreadRows({ entries, onJump, inset = false }: { entries: AttentionThread[]; onJump: (entry: AttentionThread) => void; inset?: boolean }) {
  return <>
    {entries.map((entry) => {
      const { Icon, colorClass, label: status } = attentionRowStatus(entry.task);
      const name = attentionOwnerName(entry);
      const label = t("attention.item", { title: entry.task.title, name, status });
      return <button key={`${entry.kind}-${entry.kind === "bot" ? entry.botId : entry.groupId}-${entry.task.threadId}`} type="button" aria-label={label} title={label}
        onClick={() => onJump(entry)}
        className={cn("flex w-full items-center gap-2.5 text-left text-[13px] text-ink hover:bg-menu-hover", inset ? "rounded-md px-2 py-1.5" : "px-3.5 py-2")}>
        <Icon size={inset ? 16 : 15} aria-hidden="true" className={cn("shrink-0", colorClass)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{entry.task.title}</span>
          <span className="block truncate text-[11px] text-ink-secondary">{name} · {status}</span>
        </span>
      </button>;
    })}
  </>;
}

export function PinnedThreadRows({ entries, now, onJump, onUnpin }: { entries: AttentionThread[]; now: number; onJump: (entry: AttentionThread) => void; onUnpin: (entry: AttentionThread) => void }) {
  return <>
    {entries.map((entry) => {
      const name = attentionOwnerName(entry);
      const status = attentionRowStatus(entry.task);
      const updated = threadUpdatedLabel(threadRecency(entry.task), now);
      const byline = status.active ? `${name} · ${status.label}` : updated ? `${name} · ${updated}` : name;
      const label = t("sidebar.pinnedThreads.item", { title: entry.task.title, name: byline });
      const unpinLabel = t("sidebar.bot.unpin");
      const key = `${entry.kind}-${entry.kind === "bot" ? entry.botId : entry.groupId}-${entry.task.threadId}`;
      const Icon = status.active ? status.Icon : Pin;
      return <div key={key} className="group/pinned flex w-full items-center">
        <button type="button" aria-label={label} title={label}
          onClick={() => onJump(entry)}
          className="flex min-w-0 flex-1 items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-ink hover:bg-menu-hover">
          <Icon size={15} aria-hidden="true" className={cn("shrink-0", status.active ? status.colorClass : "text-ink-secondary")} />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{entry.task.title}</span>
            <span className="block truncate text-[11px] text-ink-secondary">{byline}</span>
          </span>
        </button>
        <button type="button" aria-label={unpinLabel} title={unpinLabel} onClick={() => onUnpin(entry)}
          className="mr-2 flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover/pinned:opacity-100 max-md:opacity-70 touch:opacity-70">
          <PinOff size={13} aria-hidden="true" />
        </button>
      </div>;
    })}
  </>;
}

export function SidebarBotActivity({ bot, rowThreadId, density, pendingQueued, dispatch }: { bot: Bot; rowThreadId: string; density: SidebarDensity; pendingQueued: AppState["pendingQueued"]; dispatch: Dispatch<Action> }) {
  const tasks = threadsWhenTreeHidden(bot, pendingQueued).filter((task) => task.threadId !== rowThreadId);
  if (!tasks.length) return null;
  const iconOnly = density === "icons";
  return <div data-sidebar-bot-activity={bot.id} className={cn("mb-1 space-y-0.5", !iconOnly && "ml-6")}>
    {tasks.map((task) => {
      const waiting = task.activity === "waiting-on-you";
      const teammateWait = !waiting && task.waitingForTeammates === true;
      const working = !waiting && !teammateWait && (task.busy || task.activity === "working");
      const status = waiting ? t("sidebar.preview.waiting") : working ? t("chat.activity.working") : teammateWait ? t("sidebar.preview.waitingOnTeammate") : task.queued ? t("task.queued") : t("task.unread");
      const title = localizedTaskTitle(task.title);
      const label = `${bot.name}: ${title} · ${status}${task.unread && (waiting || working || teammateWait || task.queued) ? ` · ${t("task.unread")}` : ""}`;
      const Icon = waiting ? CircleAlert : working ? Loader2 : teammateWait || task.queued ? Clock3 : BellDot;
      return <button key={task.threadId} type="button" data-sidebar-activity-row={task.threadId} aria-label={label} title={label}
        onClick={() => dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId })}
        className={cn("flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] outline-none hover:bg-raised/50 focus-visible:ring-1 focus-visible:ring-accent/60", iconOnly && "justify-center", waiting ? "text-warning" : "text-ink-secondary")}>
        <Icon size={12} aria-hidden="true" className={cn("shrink-0", working && "animate-spin text-success", teammateWait && "text-warning", task.unread && !waiting && !working && !teammateWait && "text-accent")} />
        {!iconOnly && <><span className="min-w-0 flex-1 truncate">{title}</span><span className="shrink-0 text-[10px]">{waiting ? t("task.waiting") : status}</span>
          {task.unread && (waiting || working || teammateWait || task.queued) && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />}</>}
      </button>;
    })}
  </div>;
}
