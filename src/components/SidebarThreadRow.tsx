import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, BellOff, Clock, Clock3, FolderInput, Link2, Loader2, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import type { BotProject, Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { nextRename } from "@/lib/rename";
import { threadRefUrl } from "@/lib/thread-refs";
import { ConfirmDialog } from "./ConfirmDialog";

type ThreadRowTask = Pick<Task, "threadId" | "title" | "projectId" | "busy" | "activity" | "unread" | "openedBy" | "closedBy" | "archivedAt" | "snoozedUntil" | "waitingForTeammates"> & {
  queued?: boolean;
  pinned?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

/** Local date and time. The runtime's timezone and locale are used on
 * purpose: a desktop in Tokyo and one in New York should not be forced
 * onto UTC. */
export function formatUpdatedAt(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  return new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

/** Newest message, else when the thread was created. Missing stamps sort as
 * oldest so a half-loaded row cannot jump the list as NaN. */
export function threadRecency(task: { updatedAt?: number; createdAt?: number }): number {
  if (typeof task.updatedAt === "number" && Number.isFinite(task.updatedAt)) return task.updatedAt;
  if (typeof task.createdAt === "number" && Number.isFinite(task.createdAt)) return task.createdAt;
  return 0;
}

/** Pin, then newest update. Equal stamps keep the caller's order. Attention
 * state does not move a row — the bell and the activity hatch still use
 * orderedSidebarThreads for that. */
export function orderedThreadList<T extends { pinned?: boolean; updatedAt?: number; createdAt?: number }>(tasks: T[]): T[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      const pin = Number(b.task.pinned === true) - Number(a.task.pinned === true);
      if (pin) return pin;
      const recency = threadRecency(b.task) - threadRecency(a.task);
      if (recency) return recency;
      return a.index - b.index;
    })
    .map((entry) => entry.task);
}

/** "opened by Scout" for a thread a bot started, null for the person's own.
 * Shared by the sidebar row and the All-threads picker so both say it the
 * same quiet way. */
export function threadOpenerLabel(task: Pick<Task, "openedBy">): string | null {
  const name = task.openedBy?.name.trim();
  return name ? t("task.openedBy", { name }) : null;
}

/** The one line under a title: "closed by Scout" once a bot has closed the
 * thread, "Archived" once the person put it away, "Snoozed" while it sleeps,
 * otherwise who opened it, otherwise nothing. Closed wins because it is the
 * newer fact; archived and snoozed win over the opener because each explains
 * why the row sits where it does. */
export function threadByline(task: Pick<Task, "openedBy" | "closedBy" | "archivedAt" | "snoozedUntil">): string | null {
  const closer = task.closedBy?.name.trim();
  if (closer) return t("task.closedBy", { name: closer });
  if (isArchived(task)) return t("task.archived");
  return isSnoozed(task) ? t("task.snoozed") : threadOpenerLabel(task);
}

/** Archived means the field is present, not truthy: the task API accepts any
 * epoch number, so a thread persisted with archivedAt: 0 is archived. */
export const isArchived = (task: Pick<Task, "archivedAt">): boolean => task.archivedAt !== undefined;

/** Snoozed means asleep right now: 0 is the "until new activity" sentinel
 * and sleeps until woken, while a timestamp sleeps only until it passes.
 * The server drops expired snoozes from snapshots, but a live event stream
 * never refreshes one, so the client checks the clock too. */
export const isSnoozed = (task: Pick<Task, "snoozedUntil">, now = Date.now()): boolean =>
  task.snoozedUntil !== undefined && (task.snoozedUntil === 0 || task.snoozedUntil > now);

/** The next local 6 PM — "later today", rolling to tomorrow evening once
 * tonight's is already past. Local on purpose: it is the person's evening;
 * the server stores the absolute moment either way. */
const nextSixPm = () => {
  const when = new Date();
  when.setHours(18, 0, 0, 0);
  if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
  return when.getTime();
};

/** Tomorrow morning at 9 local: a clean overnight break, no new deps. */
const tomorrowNineAm = () => {
  const when = new Date();
  when.setDate(when.getDate() + 1);
  when.setHours(9, 0, 0, 0);
  return when.getTime();
};

/** Working is activity or flag: the wire can carry either alone, so the
 * visibility filter, the Working status, and the busy-disabled actions must
 * all ask the same question. */
const isWorking = (task: Pick<Task, "activity" | "busy">): boolean => task.activity === "working" || Boolean(task.busy);

/** The current wire distinguishes coordination waits from provider work. */
const isWaitingOnTeammate = (task: Pick<Task, "waitingForTeammates">): boolean =>
  task.waitingForTeammates === true;

/** Whether a row must stay on screen regardless of age or closed state:
 * the person is looking at it, it needs them, or it has something new. */
const demandsAttention = (task: ThreadRowTask, activeId: string) =>
  task.threadId === activeId || task.activity === "waiting-on-you" || isWorking(task) || isWaitingOnTeammate(task) || Boolean(task.queued) || Boolean(task.unread);

/** The default list is the six most recently updated OPEN threads, plus
 * anything pinned or demanding attention. Pins and attention rows do not
 * consume one of the six. A thread a bot closed is folded away — a PM bot
 * that opened ten helper threads and closed them must not leave ten rows
 * behind — but it is never gone: "show all" and search still list it, a
 * closed thread that becomes busy or unread is back at once, and a pin
 * keeps a closed or archived thread in the list. */
export function visibleSidebarThreads<T extends ThreadRowTask>(tasks: T[], activeId: string, query = "", folders: BotProject[] = [], showAll = false): T[] {
  const needle = query.trim().toLowerCase();
  if (needle) {
    return tasks.filter((task) => task.title.toLowerCase().includes(needle) || folders.some((folder) => folder.id === task.projectId && folder.name.toLowerCase().includes(needle)));
  }
  if (showAll) return tasks;
  let open = 0;
  return orderedThreadList(tasks).filter((task) => {
    if (task.pinned === true) return true;
    return task.closedBy || isArchived(task) || isSnoozed(task)
      ? demandsAttention(task, activeId)
      : open++ < 6 || demandsAttention(task, activeId);
  });
}

/** The soonest still-future timed snooze in a list, undefined when nothing
 * is scheduled to wake: 0 sleeps until activity and never ticks, and a
 * timestamp already in the past has nothing left to wait for. */
export const nextSnoozeExpiry = (tasks: readonly Pick<Task, "snoozedUntil">[], now = Date.now()): number | undefined =>
  tasks.reduce<number | undefined>((soonest, task) => {
    const until = task.snoozedUntil;
    return until !== undefined && until > 0 && until > now ? Math.min(soonest ?? Number.POSITIVE_INFINITY, until) : soonest;
  }, undefined);

/** A timed snooze ends on the wall clock, not on a server ping: rerender
 * the list when the nearest one expires so its row folds back in without
 * waiting for the next snapshot. */
export function useSnoozeExpiry(tasks: readonly Pick<Task, "snoozedUntil">[]): void {
  const [tick, rerender] = useState(0);
  const next = nextSnoozeExpiry(tasks);
  useEffect(() => {
    if (next === undefined) return;
    // Timers clamp delays above 2^31-1 to almost zero. Recheck distant
    // deadlines in bounded chunks and also handle expiry before this effect.
    const id = window.setTimeout(() => rerender((count) => count + 1), Math.max(1, Math.min(2_147_483_647, next - Date.now() + 1)));
    return () => window.clearTimeout(id);
  }, [next, tick]);
}
/** Attention outranks recency within a bot: waiting-on-you needs the person
 * most, then working/busy, then a teammate wait, then queued, then unread.
 * The thread being looked at rides just
 * above the idle tail; idle threads keep stored order. Pure and shared so
 * the tree, the collapsed escape hatch, and the pickers agree. */
const attentionRank = (task: ThreadRowTask, activeId: string): number => {
  if (task.activity === "waiting-on-you") return 0;
  if (isWaitingOnTeammate(task)) return 2;
  if (task.busy || task.activity === "working") return 1;
  if (task.queued) return 3;
  if (task.unread) return 4;
  if (task.threadId === activeId) return 5;
  return 6;
};

/** Order, never filter: whatever the caller passes stays visible, only the
 * position changes. Array#sort is stable, so equal ranks keep stored order. */
export function orderedSidebarThreads<T extends ThreadRowTask>(tasks: T[], activeId: string): T[] {
  return tasks
    .map((task, index) => ({ task, index, rank: attentionRank(task, activeId) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.task);
}

/** One quiet row for bot and group histories. Surface denotes selection;
 * working/waiting/unread remain independent signals, never different cards. */
export function SidebarThreadRow({ task, ownerId, current, compact, folders, onSelect, onRename, onDelete, onMove, onArchive, onPin, onSnooze, activityLabel }: {
  task: ThreadRowTask;
  /** the bot or room that owns the thread: the link's ?bot= */
  ownerId: string;
  current: boolean;
  compact?: boolean;
  folders?: BotProject[];
  /** Live verb the chat pane already derives ("Reading a file"); shown only while the row is working. */
  activityLabel?: string;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onMove?: (folderId: string | null) => void;
  onArchive?: (archivedAt: number | null) => void;
  onPin?: (pinned: boolean) => void;
  onSnooze?: (snoozedUntil: number | null) => void;
}) {
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [deleting, setDeleting] = useState(false);
  const finishing = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const status = task.activity === "waiting-on-you" ? t("task.waiting") : isWaitingOnTeammate(task) ? t("task.waitingOnTeammate") : isWorking(task) ? activityLabel ?? t("chat.activity.working") : task.queued ? t("task.queued") : null;
  const byline = threadByline(task);
  const updatedAt = threadRecency(task);
  const updatedLabel = formatUpdatedAt(updatedAt);
  const closed = Boolean(task.closedBy) && !status;
  const archived = isArchived(task);
  const snoozed = isSnoozed(task);
  const openMenu = (x: number, y: number) => setMenu({ left: Math.max(8, Math.min(x, window.innerWidth - 228)), top: Math.max(8, Math.min(y, window.innerHeight - 230)) });
  const startRename = () => { finishing.current = false; setDraft(task.title); setRenaming(true); setMenu(null); };
  const copyLink = () => {
    setMenu(null);
    navigator.clipboard?.writeText(threadRefUrl({ botId: ownerId, threadId: task.threadId })).catch(() => {
      // clipboard write rejected — the link stays available to copy again
    });
  };
  const finishRename = (save: boolean) => {
    if (finishing.current) return;
    finishing.current = true;
    const title = save ? nextRename(task.title, draft) : null;
    setRenaming(false);
    if (title) onRename(title);
  };
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !actionRef.current?.contains(event.target)) setMenu(null);
    };
    window.addEventListener("mousedown", outside);
    return () => window.removeEventListener("mousedown", outside);
  }, [menu]);
  /* The snooze presets make the menu taller than the 190px first guess, and
   * the folder picker can grow it after open: clamp the bottom edge against
   * the rendered height so the final actions stay reachable for lower rows. */
  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const keepOnScreen = () => {
      const el = menuRef.current;
      if (!el) return;
      const top = Math.max(8, window.innerHeight - el.offsetHeight - 8);
      setMenu((current) => (current && current.top > top ? { ...current, top } : current));
    };
    keepOnScreen();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keepOnScreen);
    observer?.observe(menuRef.current);
    window.addEventListener("resize", keepOnScreen);
    return () => { observer?.disconnect(); window.removeEventListener("resize", keepOnScreen); };
  }, [menu]);
  return <>
    <div className={cn("group/thread relative flex min-w-0 items-center rounded-md", current ? "bg-raised" : "hover:bg-raised/50")}>
      {renaming ? <input autoFocus value={draft} maxLength={80} aria-label={t("task.renameAria")}
        onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)} onBlur={() => finishRename(true)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finishRename(true); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishRename(false); } }}
        className="m-1 min-w-0 flex-1 rounded border border-accent/50 bg-inset px-2 py-1 text-[12.5px] text-ink outline-none" /> : <button
        type="button" data-sidebar-thread-row={task.threadId} aria-current={current ? "page" : undefined}
        title={[task.title, updatedLabel, status, closed ? t("task.closed") : null, archived ? t("task.archived") : null, snoozed ? t("task.snoozed") : null, task.unread ? t("task.unread") : null].filter(Boolean).join(" · ")}
        onClick={onSelect} onDoubleClick={startRename}
        onContextMenu={(event) => { event.preventDefault(); openMenu(event.clientX, event.clientY); }}
        onKeyDown={(event) => { if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.left, rect.bottom); } }}
        className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md pl-6 pr-1 text-left text-[13px] font-medium outline-none focus-visible:ring-1 focus-visible:ring-accent/60", compact ? "min-h-7 py-1" : "min-h-8 py-1.5", current ? "font-semibold text-ink" : "text-ink-secondary hover:text-ink")}>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className={cn("min-w-0 truncate", task.unread && "font-semibold text-ink", (closed || archived || snoozed) && !current && "text-ink-secondary/70")}>{task.title}</span>
          {byline && (
            // the same line and size as the title, only quieter: a second
            // line per thread made the list twice as tall as it needs to be
            <span className="min-w-0 max-w-[45%] shrink truncate font-normal text-ink-secondary/80">{byline}</span>
          )}
        </span>
        {updatedLabel && <time dateTime={new Date(updatedAt).toISOString()} className="shrink-0 tabular-nums text-[10px] text-ink-secondary">{updatedLabel}</time>}
        {task.pinned === true && <Pin size={11} className="shrink-0 text-ink-secondary" aria-label={t("sidebar.bot.pin")} />}
        {task.activity === "waiting-on-you" ? <span className="shrink-0 text-[10px] font-medium text-warning">{t("task.waiting")}</span> : isWaitingOnTeammate(task) ? <Clock3 size={11} className="shrink-0 text-ink-secondary" aria-label={t("task.waitingOnTeammate")} /> : isWorking(task) ? <Loader2 size={11} className="shrink-0 animate-spin text-success" aria-label={activityLabel ?? t("chat.activity.working")} /> : task.queued ? <span className="shrink-0 text-[10px] text-ink-secondary">{t("task.queued")}</span> : null}
        {task.unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unread")} />}
      </button>}
      <button ref={actionRef} type="button" aria-label={t("task.actions", { title: task.title })} aria-expanded={Boolean(menu)}
        onClick={(event) => { if (menu) { setMenu(null); return; } const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.left, rect.bottom); }}
        className="mr-0.5 flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover/thread:opacity-100 max-md:opacity-70">
        <MoreHorizontal size={13} />
      </button>
    </div>
    {menu && createPortal(<div ref={menuRef} data-thread-overlay role="group" aria-label={t("task.actions", { title: task.title })} style={menu}
      className="fixed z-50 max-h-[calc(100vh-16px)] w-[220px] overflow-y-auto rounded-lg border border-hairline/50 bg-card p-1 shadow-xl"
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(null); actionRef.current?.focus(); } }}>
      <button type="button" onClick={copyLink} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12px] text-ink hover:bg-raised"><Link2 size={12} />{t("task.copyLink")}</button>
      <button type="button" onClick={startRename} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12px] text-ink hover:bg-raised"><Pencil size={12} />{t("task.renameAria")}</button>
      {onMove && Boolean(folders?.length) && <label className="block rounded px-2.5 py-2 text-[12px] text-ink"><span className="mb-1 flex items-center gap-2 text-ink-secondary"><FolderInput size={12} />{t("folder.move")}</span>
        <select aria-label={t("folder.moveNamed", { title: task.title })} value={folders?.some((folder) => folder.id === task.projectId) ? task.projectId : ""}
          onChange={(event) => { onMove(event.target.value || null); setMenu(null); }} className="w-full rounded border border-hairline/40 bg-card px-1 py-1 text-ink outline-none">
          <option value="">{t("folder.none")}</option>{folders?.map((folder) => <option key={folder.id} value={folder.id}>{folder.emoji ? `${folder.emoji} ` : ""}{folder.name}</option>)}
        </select>
      </label>}
      {onPin && <button type="button" onClick={() => { setMenu(null); onPin(task.pinned !== true); }} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12px] text-ink hover:bg-raised">{task.pinned === true ? <PinOff size={12} /> : <Pin size={12} />}{task.pinned === true ? t("sidebar.bot.unpin") : t("sidebar.bot.pin")}</button>}
      {onArchive && <button type="button" disabled={isWorking(task)} onClick={() => { setMenu(null); onArchive(isArchived(task) ? null : Date.now()); }} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12px] text-ink hover:bg-raised disabled:opacity-40">{archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}{archived ? t("task.unarchive") : t("task.archive")}</button>}
      {onSnooze && <div className="px-2.5 pt-1">
        <span className="flex items-center gap-2 text-[11px] text-ink-secondary"><Clock size={12} />{t("task.snooze")}</span>
        <div className="mt-0.5 flex flex-col">
          {[{ label: t("task.snoozeUntilActivity"), at: 0 }, { label: t("task.snoozeTonight"), at: nextSixPm() }, { label: t("task.snoozeTomorrow"), at: tomorrowNineAm() }].map((preset) => (
            <button key={preset.label} type="button" disabled={isWorking(task)} onClick={() => { setMenu(null); onSnooze(preset.at); }} className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-raised disabled:opacity-40">{preset.label}</button>
          ))}
        </div>
      </div>}
      {onSnooze && snoozed && <button type="button" onClick={() => { setMenu(null); onSnooze(null); }} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12px] text-ink hover:bg-raised"><BellOff size={12} />{t("task.stopSnoozing")}</button>}
      <button type="button" disabled={isWorking(task)} onClick={() => { setMenu(null); setDeleting(true); }} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12px] text-danger hover:bg-raised disabled:opacity-40"><Trash2 size={12} />{t("task.deleteAria")}</button>
    </div>, document.body)}
    <ConfirmDialog open={deleting} title={t("task.deleteConfirm")} body={t("task.deleteBody", { title: task.title })} confirmLabel={t("task.deleteAria")}
      onCancel={() => setDeleting(false)} onConfirm={() => { if (!isWorking(task)) onDelete(); setDeleting(false); }} returnFocusRef={actionRef} />
  </>;
}
