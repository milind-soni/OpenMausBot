import { BellDot, CircleAlert, Clock3, Loader2, Pin, PinOff, type LucideIcon } from "lucide-react";
import type { Dispatch } from "react";
import type { Action, AppState, Bot, Group, Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { orderedSidebarThreads, orderedThreadList, threadRecency, threadUpdatedLabel } from "./SidebarThreadRow";
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

/** The unpin action for one entry — same dispatch shape as the thread row's
 * own context-menu pin toggle (Sidebar.tsx), just reachable without opening
 * the menu first. */
export function attentionUnpinAction(entry: AttentionThread):
  | { type: "updateTask"; botId: string; threadId: string; patch: { pinned: boolean } }
  | { type: "pinGroupTask"; groupId: string; threadId: string; pinned: boolean; title: string } {
  if (entry.kind === "bot") return { type: "updateTask", botId: entry.botId, threadId: entry.task.threadId, patch: { pinned: false } };
  return { type: "pinGroupTask", groupId: entry.groupId, threadId: entry.task.threadId, pinned: false, title: entry.task.title };
}

/** The pulse button's name. The count is already painted on the icon, and
 * aria-label replaces the button's contents, so the number has to be in the
 * name or a screen reader never hears it. */
export function attentionTriggerLabel(count: number): string {
  return count > 0 ? t("attention.titleCount", { count }) : t("attention.title");
}

/** Work in flight or waiting its turn. Unread and "needs you" stay on the
 * count badge; this is only the running and queued subset of that list. */
export function attentionHasRunningWork(entries: readonly AttentionThread[]): boolean {
  return entries.some((entry) => entry.task.activity === "working" || (entry.task.busy === true && entry.task.activity !== "waiting-on-you") || entry.task.queued === true);
}

/** Whether a task needs the person right now, and how to show it — the one
 * place that maps waiting/working/teammate-wait/queued/unread to an icon and
 * word, so the attention rows and the pinned rows never pick different icons
 * for the same state. */
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

/** Every pinned thread across every visible bot and room, newest pin first.
 * The pinned-threads panel's source of truth — reuses the same AttentionThread
 * shape and jump action as attention, so a pin and an attention item are
 * never handled by two different code paths. Unlike attention, idle pins are
 * the common case, not the exception. */
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

/** The one row shape for attention entries: title, bot name, status, jump.
 * Shared by the sidebar bell and the picker's attention section so both say
 * it the same way. */
export function AttentionThreadRows({ entries, onJump }: { entries: AttentionThread[]; onJump: (entry: AttentionThread) => void }) {
  return <>
    {entries.map((entry) => {
      const { Icon, colorClass, label: status } = attentionRowStatus(entry.task);
      const name = attentionOwnerName(entry);
      const label = t("attention.item", { title: entry.task.title, name, status });
      return <button key={`${entry.kind}-${entry.kind === "bot" ? entry.botId : entry.groupId}-${entry.task.threadId}`} type="button" aria-label={label} title={label}
        onClick={() => onJump(entry)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-ink hover:bg-raised/70">
        <Icon size={15} aria-hidden="true" className={cn("shrink-0", colorClass)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{entry.task.title}</span>
          <span className="block truncate text-[11px] text-ink-secondary">{name} · {status}</span>
        </span>
      </button>;
    })}
  </>;
}

/** The pinned-threads panel's row: same identity info as an attention row.
 * Most pins are idle on purpose, not waiting on anyone, so idle rows keep a
 * plain Pin icon and an "owner · updated" byline — but a pin that *is*
 * currently waiting/working/queued/unread looks exactly like its attention
 * row twin, so it never looks dead while something is actually happening.
 * A hover-reveal unpin button sits beside the row, same pattern as the
 * thread tree's own row actions (SidebarThreadRow.tsx). */
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
          className="flex min-w-0 flex-1 items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-ink hover:bg-raised/70">
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

/** The escape hatch for other ongoing conversations when their tree is hidden.
 * These are selection-only buttons: no create, rename, move, or delete menu. */
export function SidebarBotActivity({ bot, density, pendingQueued, dispatch }: { bot: Bot; density: SidebarDensity; pendingQueued: AppState["pendingQueued"]; dispatch: Dispatch<Action> }) {
  const tasks = threadsWhenTreeHidden(bot, pendingQueued).filter((task) => task.threadId !== bot.threadId);
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
