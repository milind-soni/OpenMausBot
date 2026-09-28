import { BellDot, CircleAlert, Clock3, Loader2 } from "lucide-react";
import { useStore, type Bot, type Group, type Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { orderedSidebarThreads, orderedThreadList } from "./SidebarThreadRow";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

/** Attention is not history browsing: idle conversations never enter this list.
 * Read the sibling's own status, not the bot's aggregate busy/waiting flags. */
export function sidebarBotActivityTasks(bot: Bot, queued: Record<string, unknown[]>): Array<Task & { queued: boolean }> {
  const tasks = bot.tasks ?? [{
    threadId: bot.threadId, title: t("task.newShort"), createdAt: 0,
    busy: bot.busy, activity: bot.activity, unread: bot.unread,
    waitingForTeammates: bot.waitingForTeammates,
  }];
  return tasks.map((task) => ({ ...task, queued: Boolean(queued[task.threadId]?.length) }))
    // Routine runs are reachable through their run receipt, never a menu.
    .filter((task) => !task.routineRunId)
    .filter((task) => task.activity === "waiting-on-you" || task.activity === "working" || task.busy || task.waitingForTeammates === true || task.queued || task.unread);
}

/** What stays reachable when the thread tree is folded away: anything that
 * needs the person, plus a pin, in pin-then-update order. The bell does not
 * use this — it stays on attention order. */
export function threadsWhenTreeHidden(bot: Bot, queued: Record<string, unknown[]>) {
  const attention = sidebarBotActivityTasks(bot, queued);
  const seen = new Set(attention.map((task) => task.threadId));
  const pinned = (bot.tasks ?? [])
    .filter((task) => task.pinned === true && !task.routineRunId && !seen.has(task.threadId))
    .map((task) => ({ ...task, queued: Boolean(queued[task.threadId]?.length) }));
  return orderedThreadList([...attention, ...pinned]);
}

/** The room-level twin of sidebarBotActivityTasks: a room's own aggregate
 * working/busyBotId/unread state, attributed to its primary thread exactly
 * as GroupThreadList's own sidebar row derives it (Sidebar.tsx) — keep the
 * two derivations in sync. A bot⇄bot DM channel mirrors the other side's
 * own thread, so it is never attention here on its own account. */
export function sidebarGroupActivityTasks(group: Group, bots: Bot[], queued: Record<string, unknown[]>): Array<Task & { queued: boolean }> {
  if (group.dm) return [];
  const busy = Boolean(group.working || group.busyBotId);
  const waiting = bots.find((bot) => bot.id === group.busyBotId)?.activity === "waiting-on-you";
  const tasks = (group.tasks ?? [{ threadId: group.threadId, title: group.name, createdAt: group.createdAt }]).map((task) => ({
    ...task, busy: task.threadId === group.threadId && busy, unread: task.threadId === group.threadId && Boolean(group.unread),
    activity: task.threadId === group.threadId && waiting ? "waiting-on-you" as const : undefined,
  }));
  return tasks.map((task) => ({ ...task, queued: Boolean(queued[task.threadId]?.length) }))
    .filter((task) => task.activity === "waiting-on-you" || task.busy || task.queued || task.unread);
}

/** One thread that needs the person, from any bot or room other than the one
 * they are in. Built from the same attention rule and ordering as the sidebar
 * tree, so the bell, the pinned panel, and the picker's Attention section can
 * never disagree about what needs attention. */
export type AttentionThread =
  | { kind: "bot"; botId: string; botName: string; task: Task & { queued: boolean } }
  | { kind: "group"; groupId: string; groupName: string; groupThreadId: string; task: Task & { queued: boolean } };

/** The name to show for one entry, whichever kind it is — shared so the
 * picker's search filter and the rendered rows can never disagree. */
export function attentionOwnerName(entry: AttentionThread): string {
  return entry.kind === "bot" ? entry.botName : entry.groupName;
}

/** The switch action for jumping to one entry — shared so the bell, the
 * pinned panel, and the picker dispatch a jump the same way. A room's own
 * thread selects the room; one of its separate conversations switches to it
 * the same way GroupThreadList's own row does. */
export function attentionJumpAction(entry: AttentionThread):
  | { type: "switchTask"; botId: string; threadId: string }
  | { type: "switchGroupTask"; groupId: string; threadId: string }
  | { type: "select"; id: string } {
  if (entry.kind === "bot") return { type: "switchTask", botId: entry.botId, threadId: entry.task.threadId };
  return entry.task.threadId === entry.groupThreadId
    ? { type: "select", id: entry.groupId }
    : { type: "switchGroupTask", groupId: entry.groupId, threadId: entry.task.threadId };
}

type FlatAttentionEntry = Task & {
  queued: boolean; botId?: string; botName?: string; groupId?: string; groupName?: string; groupThreadId?: string;
};

export function crossBotAttentionThreads(
  bots: Bot[], queued: Record<string, unknown[]>, exceptBotId?: string, groups: Group[] = [],
): AttentionThread[] {
  // Flatten first, then order once: sorting each source on its own would let
  // the unread reply of an earlier bot outrank the waiting approval of a
  // later room, which the sidebar tree never does. Hidden bots stay out
  // entirely; the archived-bots panel is where they resurface.
  const flat: FlatAttentionEntry[] = [
    ...bots
      .filter((bot) => bot.id !== exceptBotId && !bot.hidden)
      .flatMap((bot): FlatAttentionEntry[] => sidebarBotActivityTasks(bot, queued)
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

/** The one row shape for attention entries: title, bot name, status, jump.
 * Shared by the sidebar bell and the picker's attention section so both say
 * it the same way. */
export function AttentionThreadRows({ entries, onJump }: { entries: AttentionThread[]; onJump: (entry: AttentionThread) => void }) {
  return <>
    {entries.map((entry) => {
      const waiting = entry.task.activity === "waiting-on-you";
      const teammateWait = !waiting && entry.task.waitingForTeammates === true;
      const working = !waiting && !teammateWait && (entry.task.busy || entry.task.activity === "working");
      const status = waiting ? t("task.waiting") : working ? t("chat.activity.working") : teammateWait ? t("task.waitingOnTeammate") : entry.task.queued ? t("task.queued") : t("task.unread");
      const name = attentionOwnerName(entry);
      const label = t("attention.item", { title: entry.task.title, name, status });
      const Icon = waiting ? CircleAlert : working ? Loader2 : teammateWait || entry.task.queued ? Clock3 : BellDot;
      return <button key={`${entry.kind}-${entry.kind === "bot" ? entry.botId : entry.groupId}-${entry.task.threadId}`} type="button" aria-label={label} title={label}
        onClick={() => onJump(entry)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-ink hover:bg-raised/70">
        <Icon size={15} aria-hidden="true" className={cn("shrink-0", working && "animate-spin text-success", waiting && "text-warning", teammateWait && "text-warning")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{entry.task.title}</span>
          <span className="block truncate text-[11px] text-ink-secondary">{name} · {status}</span>
        </span>
      </button>;
    })}
  </>;
}

/** The escape hatch for other ongoing conversations when their tree is hidden.
 * These are selection-only buttons: no create, rename, move, or delete menu. */
export function SidebarBotActivity({ bot, density }: { bot: Bot; density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const tasks = threadsWhenTreeHidden(bot, state.pendingQueued).filter((task) => task.threadId !== bot.threadId);
  if (!tasks.length) return null;
  const iconOnly = density === "icons";
  return <div data-sidebar-bot-activity={bot.id} className={cn("mb-1 space-y-0.5", !iconOnly && "ml-6")}>
    {tasks.map((task) => {
      const waiting = task.activity === "waiting-on-you";
      const teammateWait = !waiting && task.waitingForTeammates === true;
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
