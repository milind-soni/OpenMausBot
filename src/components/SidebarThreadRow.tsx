import { memo, useEffect, useRef, useState, type Dispatch, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, BellOff, Check, ChevronRight, Clock, Clock3, FolderInput, Link2, Link2Off, Loader2, MoreHorizontal, Pencil, Pin, PinOff, RefreshCw, Trash2 } from "lucide-react";
import type { Action, AppState, BotProject, Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { MENU_SHEET } from "./menu-recipe";
import { useHeldMenuMotion } from "./MenuMotion";
import { t } from "@/lib/i18n";
import { nextRename } from "@/lib/rename";
import { isTickable, opensRowMenuFromKey } from "@/lib/bulk-select";
import { threadRefUrl } from "@/lib/thread-refs";
import { copyText } from "@/lib/copy-text";
import { ConfirmDialog } from "./ConfirmDialog";
import { threadLinkLabel } from "../../shared/thread-link";
import { isSnoozed, orderedThreadList } from "../../shared/wire";
import { Select } from "./Select";
import { WorkingTimer } from "./WorkingIndicator";
import { localizedTaskTitle } from "@/lib/task-title";

export { isSnoozed, orderedThreadList };

type ThreadRowTask = Pick<Task, "threadId" | "title" | "projectId" | "busy" | "activity" | "unread" | "openedBy" | "closedBy" | "archivedAt" | "snoozedUntil" | "waitingForTeammates" | "link" | "turnStartedAt"> & {
  queued?: boolean;
  pinned?: boolean;
  createdAt?: number;
  updatedAt?: number;
  lastThreadOrderAt?: number;
};

export function formatUpdatedAt(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  return new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

export function threadUpdatedLabel(at: number, now: number): string {
  if (stampClock(at, now) === undefined) return formatUpdatedAt(at);
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return t("task.updated.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("task.updated.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (seconds < 86_400) return t("task.updated.hours", { count: hours });
  const days = Math.round(hours / 24);
  if (days === 1) return t("task.updated.yesterday");
  return t("task.updated.days", { count: days });
}

export function stampClock(at: number, now: number): number | undefined {
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(now)) return undefined;
  return Math.max(0, Math.round((now - at) / 1000)) < 7 * 86_400 ? now : undefined;
}

export function threadRecency(task: { updatedAt?: number; createdAt?: number }): number {
  if (typeof task.updatedAt === "number" && Number.isFinite(task.updatedAt)) return task.updatedAt;
  if (typeof task.createdAt === "number" && Number.isFinite(task.createdAt)) return task.createdAt;
  return 0;
}

export function threadOpenerLabel(task: Pick<Task, "openedBy">): string | null {
  const name = task.openedBy?.name.trim();
  return name ? t("task.openedBy", { name }) : null;
}

export function threadByline(task: Pick<Task, "openedBy" | "closedBy" | "archivedAt" | "snoozedUntil">): string | null {
  const closer = task.closedBy?.name.trim();
  if (closer) return t("task.closedBy", { name: closer });
  if (isArchived(task)) return t("task.archived");
  return isSnoozed(task) ? t("task.snoozed") : threadOpenerLabel(task);
}

/** Present, not truthy: a thread stored with archivedAt: 0 is archived. */
export const isArchived = (task: Pick<Task, "archivedAt">): boolean => task.archivedAt !== undefined;

const nextSixPm = () => {
  const when = new Date();
  when.setHours(18, 0, 0, 0);
  if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
  return when.getTime();
};

const tomorrowNineAm = () => {
  const when = new Date();
  when.setDate(when.getDate() + 1);
  when.setHours(9, 0, 0, 0);
  return when.getTime();
};

const isWorking = (task: Pick<Task, "activity" | "busy">): boolean => task.activity === "working" || Boolean(task.busy);

const isWaitingOnTeammate = (task: Pick<Task, "waitingForTeammates">): boolean =>
  task.waitingForTeammates === true;

const demandsAttention = (task: ThreadRowTask, activeId: string) =>
  task.threadId === activeId || task.activity === "waiting-on-you" || isWorking(task) || isWaitingOnTeammate(task) || Boolean(task.queued) || Boolean(task.unread);

export function partitionHelperThreads<T extends ThreadRowTask>(tasks: T[], activeId: string, query = "", folders: BotProject[] = []): { own: T[]; helpers: T[] } {
  if (query.trim()) return { own: tasks, helpers: [] };
  const own: T[] = [];
  const helpers: T[] = [];
  for (const task of tasks) {
    const filed = folders.some((folder) => folder.id === task.projectId);
    const needsPerson = task.threadId === activeId || task.activity === "waiting-on-you" || Boolean(task.unread);
    const helper = Boolean(task.openedBy) && task.pinned !== true && !filed && !needsPerson &&
      !task.closedBy && !isArchived(task) && !isSnoozed(task);
    (helper ? helpers : own).push(task);
  }
  return { own, helpers };
}

export function HelperThreadGroup<T>({ tasks, busy, renderThread }: { tasks: T[]; busy: boolean; renderThread: (task: T) => ReactNode }) {
  const [open, setOpen] = useState(false);
  if (tasks.length === 0) return null;
  const label = t("task.helperGroup");
  return <div data-sidebar-helper-threads="">
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} aria-label={t(open ? "task.collapseNamed" : "task.expandNamed", { name: label })}
      className="flex min-h-8 w-full items-center gap-1.5 rounded-md py-1 pl-1.5 pr-3 text-left text-[12px] text-ink-secondary hover:bg-raised/30 hover:text-ink">
      <ChevronRight aria-hidden="true" size={11} className={cn("shrink-0 transition-transform", open && "rotate-90")} />
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-[10px] opacity-50">{tasks.length}</span>
      {!open && busy && <Loader2 size={10} className="shrink-0 animate-spin text-success" />}
    </button>
    {open && <div role="group" aria-label={label}>{tasks.map(renderThread)}</div>}
  </div>;
}

export function visibleSidebarThreads<T extends ThreadRowTask>(tasks: T[], activeId: string, query = "", folders: BotProject[] = [], showAll = false): T[] {
  const needle = query.trim().toLowerCase();
  if (needle) {
    return tasks.filter((task) => task.title.toLowerCase().includes(needle) || folders.some((folder) => folder.id === task.projectId && folder.name.toLowerCase().includes(needle)));
  }
  if (showAll) return tasks;
  let open = 0;
  return orderedThreadList(tasks).filter((task) => {
    if (task.pinned === true) return true;
    if (isArchived(task)) return task.threadId === activeId;
    return task.closedBy || isSnoozed(task)
      ? demandsAttention(task, activeId)
      : open++ < 6 || demandsAttention(task, activeId);
  });
}

export const nextSnoozeExpiry = (tasks: readonly Pick<Task, "snoozedUntil">[], now = Date.now()): number | undefined =>
  tasks.reduce<number | undefined>((soonest, task) => {
    const until = task.snoozedUntil;
    return until !== undefined && until > 0 && until > now ? Math.min(soonest ?? Number.POSITIVE_INFINITY, until) : soonest;
  }, undefined);

export function useSnoozeExpiry(tasks: readonly Pick<Task, "snoozedUntil">[]): void {
  const [tick, rerender] = useState(0);
  const next = nextSnoozeExpiry(tasks);
  useEffect(() => {
    if (next === undefined) return;
    // setTimeout treats delays above 2^31-1 ms as ~0, so distant deadlines are rechecked in bounded chunks.
    const id = window.setTimeout(() => rerender((count) => count + 1), Math.max(1, Math.min(2_147_483_647, next - Date.now() + 1)));
    return () => window.clearTimeout(id);
  }, [next, tick]);
}

export function useRevealedThreadRow(reveal: AppState["revealThread"], currentThreadId: string | null) {
  useEffect(() => {
    if (!reveal || reveal.threadId !== currentThreadId) return;
    const row = document.querySelector<HTMLElement>(`[data-sidebar-thread-row="${CSS.escape(reveal.threadId)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [reveal, currentThreadId]);
}

export function useRelativeNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const sync = () => { if (document.visibilityState === "visible") setNow(Date.now()); };
    const timer = window.setInterval(sync, 30_000);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return now;
}
const attentionRank = (task: ThreadRowTask, activeId: string): number => {
  if (task.activity === "waiting-on-you") return 0;
  if (isWaitingOnTeammate(task)) return 2;
  if (task.busy || task.activity === "working") return 1;
  if (task.queued) return 3;
  if (task.unread) return 4;
  if (task.threadId === activeId) return 5;
  return 6;
};

export function orderedSidebarThreads<T extends ThreadRowTask>(tasks: T[], activeId: string): T[] {
  return tasks
    .map((task, index) => ({ task, index, rank: attentionRank(task, activeId) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.task);
}

/** The store actions behind a bot's thread-row menu, for every list that draws that bot's threads. */
export function threadRowActions(botId: string, dispatch: Dispatch<Action>, generatedTitles: boolean) {
  return {
    onRename: (task: { threadId: string }, title: string) => dispatch({ type: "renameTask", botId, threadId: task.threadId, title }),
    onRegenerateTitle: generatedTitles ? (task: { threadId: string }, onSettled: (ok: boolean) => void) => dispatch({ type: "regenerateTaskTitle", botId, threadId: task.threadId, onSettled }) : undefined,
    onDelete: (task: { threadId: string }) => dispatch({ type: "deleteTask", botId, threadId: task.threadId }),
    onMove: (task: { threadId: string }, projectId: string | null) => dispatch({ type: "updateTask", botId, threadId: task.threadId, patch: { projectId } }),
    onArchive: (task: { threadId: string }, archivedAt: number | null) => dispatch({ type: "updateTask", botId, threadId: task.threadId, patch: { archivedAt } }),
    onPin: (task: { threadId: string }, pinned: boolean) => dispatch({ type: "updateTask", botId, threadId: task.threadId, patch: { pinned } }),
    onSnooze: (task: { threadId: string }, snoozedUntil: number | null) => dispatch({ type: "updateTask", botId, threadId: task.threadId, patch: { snoozedUntil } }),
    onLink: (task: { threadId: string }, link: string | null) => dispatch({ type: "updateTask", botId, threadId: task.threadId, patch: { link } }),
  };
}

type ThreadRowProps = {
  task: ThreadRowTask;
  ownerId: string;
  current: boolean;
  compact?: boolean;
  folders?: BotProject[];
  activityLabel?: string;
  now?: number;
  locale: string;
  onSelect: (task: ThreadRowTask) => void;
  onRename: (task: ThreadRowTask, title: string) => void;
  onRegenerateTitle?: (task: ThreadRowTask, onSettled: (ok: boolean) => void) => void;
  onDelete: (task: ThreadRowTask) => void;
  onMove?: (task: ThreadRowTask, folderId: string | null) => void;
  onArchive?: (task: ThreadRowTask, archivedAt: number | null) => void;
  onPin?: (task: ThreadRowTask, pinned: boolean) => void;
  onSnooze?: (task: ThreadRowTask, snoozedUntil: number | null) => void;
  onLink?: (task: ThreadRowTask, link: string | null) => void;
  onRefreshPermissions?: (task: ThreadRowTask) => void;
  selectMode?: boolean;
  checked?: boolean;
  onToggleSelect?: (task: ThreadRowTask, shiftKey: boolean) => void;
  /** The bot panel's taller row: `preview` (the conversation's last line) under the title, and how long a running turn
   * has worked. */
  panel?: boolean;
  preview?: string;
};

const sameFields = <T extends object>(a: T, b: T): boolean => {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
};

const sameThreadRow = ({ task: previousTask, ...previous }: ThreadRowProps, { task, ...next }: ThreadRowProps): boolean =>
  sameFields(previousTask, task) && sameFields(previous, next);

export const SidebarThreadRow = memo(function SidebarThreadRow({ task, ownerId, current, compact, folders, onSelect, onRename, onRegenerateTitle, onDelete, onMove, onArchive, onPin, onSnooze, onLink, onRefreshPermissions, activityLabel, now, selectMode = false, checked = false, onToggleSelect, panel = false, preview }: ThreadRowProps) {
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const menuMotion = useHeldMenuMotion(menu);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [deleting, setDeleting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const displayTitle = localizedTaskTitle(task.title);
  const finishing = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const status = task.activity === "waiting-on-you" ? t("task.waiting") : isWaitingOnTeammate(task) ? t("task.waitingOnTeammate") : isWorking(task) ? activityLabel ?? t("chat.activity.working") : task.queued ? t("task.queued") : null;
  const byline = threadByline(task);
  const updatedAt = threadRecency(task);
  const updatedStamp = formatUpdatedAt(updatedAt);
  const updatedLabel = now === undefined ? updatedStamp : threadUpdatedLabel(updatedAt, now);
  const closed = Boolean(task.closedBy) && !status;
  const archived = isArchived(task);
  const snoozed = isSnoozed(task);
  const tickable = isTickable(task);
  const choose = (event: React.MouseEvent) => { if (!selectMode) onSelect(task); else if (tickable) onToggleSelect?.(task, event.shiftKey); };
  const contextMenu = (event: React.MouseEvent) => { event.preventDefault(); if (!selectMode) openMenu(event.clientX, event.clientY); };
  const openMenu = (x: number, y: number) => setMenu({ left: Math.max(8, Math.min(x, window.innerWidth - 228)), top: Math.max(8, Math.min(y, window.innerHeight - 230)) });
  const startRename = () => { finishing.current = false; setDraft(task.title); setRenaming(true); setMenu(null); };
  const copyLink = () => {
    setMenu(null);
    void copyText(threadRefUrl({ botId: ownerId, threadId: task.threadId }));
  };
  const regenerateTitle = () => {
    if (!onRegenerateTitle || regenerating) return;
    setRegenerating(true);
    onRegenerateTitle(task, (ok) => { setRegenerating(false); if (ok) setMenu(null); });
  };
  const finishRename = (save: boolean) => {
    if (finishing.current) return;
    finishing.current = true;
    const title = save ? nextRename(task.title, draft) : null;
    setRenaming(false);
    if (title) onRename(task, title);
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
  const heading = <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
    <span dir="auto" className={cn("min-w-0 flex-1 max-w-max truncate", task.unread && "font-semibold text-ink", (closed || archived || snoozed) && !current && "text-ink-tertiary")}>{displayTitle}</span>
    {byline && (
      <span className="min-w-0 max-w-[45%] shrink truncate font-normal text-ink-tertiary">{byline}</span>
    )}
  </span>;
  return <>
    <div className={cn("group/thread relative flex min-w-0 items-center rounded-md", selectMode && checked ? "bg-accent/10" : current ? "bg-raised" : "hover:bg-raised/50", panel && cn("items-start rounded-[10px]", current ? "bg-ink/[0.07]" : "hover:bg-ink/[0.04]"))}>
      {renaming ? <input autoFocus value={draft} maxLength={80} aria-label={t("task.renameAria")}
        onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)} onBlur={() => finishRename(true)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finishRename(true); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishRename(false); } }}
        dir="auto" className="m-1 min-w-0 flex-1 rounded border border-accent/50 bg-inset px-2 py-1 text-[13px] text-ink outline-none" /> : <button
        type="button" data-sidebar-thread-row={task.threadId} aria-current={current ? "page" : undefined}
        title={[displayTitle, updatedStamp, status, closed ? t("task.closed") : null, archived ? t("task.archived") : null, snoozed ? t("task.snoozed") : null, task.unread ? t("task.unread") : null].filter(Boolean).join(" · ")}
        {...(selectMode ? { role: "checkbox", "aria-checked": checked, "aria-disabled": !tickable, "aria-label": t("task.bulk.rowCheck", { title: displayTitle }) } : {})}
        onClick={choose} onDoubleClick={selectMode ? undefined : startRename} onContextMenu={contextMenu}
        onKeyDown={(event) => { if (opensRowMenuFromKey(event.key, event.shiftKey, selectMode)) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.left, rect.bottom); } }}
        className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md pl-6 pr-1 text-left text-[13px] font-medium outline-none focus-visible:ring-1 focus-visible:ring-accent/60", compact ? "min-h-7 py-1" : "min-h-8 py-1.5", current ? "font-semibold text-ink" : "text-ink-secondary hover:text-ink", panel && "rounded-[10px] py-2 pl-3 text-[14px]", selectMode && "pl-1.5", selectMode && !tickable && "cursor-not-allowed opacity-60")}>
        {selectMode && <span aria-hidden="true" title={tickable ? undefined : t("task.bulk.running")}
          className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border", checked ? "border-accent bg-accent text-white" : "border-ink-tertiary", !tickable && "opacity-50")}>
          {checked && <Check size={10} strokeWidth={3} />}
        </span>}
        {panel ? <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {heading}
          {preview && <span dir="auto" className="truncate text-[13px] font-normal text-ink-secondary">{preview}</span>}
          {isWorking(task) && <span data-thread-working="" className="flex items-center gap-1 text-[12px] font-normal text-success">
            {t("chat.activity.working")}{task.turnStartedAt ? <><span aria-hidden="true">·</span><WorkingTimer since={task.turnStartedAt} /></> : null}
          </span>}
        </span> : heading}
      </button>}
      {task.link && <a href={task.link} target="_blank" rel="noreferrer" dir="ltr" title={task.link} aria-label={t("task.openLink", { link: threadLinkLabel(task.link) ?? task.link })}
        className="shrink-0 rounded px-1 font-mono text-[11px] text-ink-secondary hover:bg-raised hover:text-ink outline-none focus-visible:ring-1 focus-visible:ring-accent/60 [unicode-bidi:isolate]">{threadLinkLabel(task.link) ?? t("task.link")}</a>}
      {!renaming && <span className={cn("flex shrink-0 items-center gap-2 px-1", panel && "pt-2.5")} onClick={choose} onContextMenu={contextMenu}>
        {updatedLabel && <time dateTime={new Date(updatedAt).toISOString()} className="shrink-0 tabular-nums text-[10px] text-ink-secondary">{updatedLabel}</time>}
        {task.pinned === true && <Pin size={11} className="shrink-0 text-ink-secondary" aria-label={t("sidebar.bot.pin")} />}
        {task.activity === "waiting-on-you" ? <span className="shrink-0 text-[10px] font-medium text-warning">{t("task.waiting")}</span> : isWaitingOnTeammate(task) ? <Clock3 size={11} className="shrink-0 text-ink-secondary" aria-label={t("task.waitingOnTeammate")} /> : isWorking(task) && !panel ? <Loader2 size={11} className="shrink-0 animate-spin text-success" aria-label={activityLabel ?? t("chat.activity.working")} /> : task.queued ? <span className="shrink-0 text-[10px] text-ink-secondary">{t("task.queued")}</span> : null}
        {task.unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unread")} />}
      </span>}
      {!selectMode && <button ref={actionRef} type="button" aria-label={t("task.actions", { title: displayTitle })} aria-expanded={Boolean(menu)}
        onClick={(event) => { if (menu) { setMenu(null); return; } const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.left, rect.bottom); }}
        className={cn("mr-0.5 flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover/thread:opacity-100 max-md:opacity-70 touch:opacity-70", panel && "mt-1.5")}>
        <MoreHorizontal size={13} />
      </button>}
    </div>
    {menuMotion.shown && menuMotion.value && createPortal(<div ref={menuRef} data-thread-overlay role="group" aria-label={t("task.actions", { title: displayTitle })} style={menuMotion.value}
      className={cn("fixed z-50 max-h-[calc(100vh-16px)] w-[220px] overflow-y-auto", MENU_SHEET, menuMotion.className)} {...menuMotion.exitProps}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(null); actionRef.current?.focus(); } }}>
      <button type="button" onClick={copyLink} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-ink hover:bg-menu-hover"><Link2 size={16} />{t("task.copyLink")}</button>
      <button type="button" onClick={startRename} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-ink hover:bg-menu-hover"><Pencil size={16} />{t("task.renameAria")}</button>
      {onRegenerateTitle && <button type="button" disabled={regenerating} aria-busy={regenerating} onClick={regenerateTitle} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-ink hover:bg-menu-hover disabled:opacity-40">{regenerating ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}{regenerating ? t("task.regeneratingTitle") : t("task.regenerateTitle")}</button>}
      {onMove && Boolean(folders?.length) && <label className="block rounded-md px-2 py-1.5 text-[13px] text-ink"><span className="mb-1 flex items-center gap-2 text-ink-secondary"><FolderInput size={16} />{t("folder.move")}</span>
        <Select size="sm" className="w-full" aria-label={t("folder.moveNamed", { title: task.title })} value={folders?.some((folder) => folder.id === task.projectId) ? task.projectId : ""}
          onChange={(event) => { onMove(task, event.target.value || null); setMenu(null); }}>
          <option value="">{t("folder.none")}</option>{folders?.map((folder) => <option key={folder.id} value={folder.id}>{folder.emoji ? `${folder.emoji} ` : ""}{folder.name}</option>)}
        </Select>
      </label>}
      {onPin && <button type="button" onClick={() => { setMenu(null); onPin(task, task.pinned !== true); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-ink hover:bg-menu-hover">{task.pinned === true ? <PinOff size={16} /> : <Pin size={16} />}{task.pinned === true ? t("sidebar.bot.unpin") : t("sidebar.bot.pin")}</button>}
      {onLink && task.link && <button type="button" onClick={() => { setMenu(null); onLink(task, null); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-ink hover:bg-menu-hover"><Link2Off size={16} />{t("task.removeLink")}</button>}
      {onArchive && <button type="button" disabled={isWorking(task)} onClick={() => { setMenu(null); onArchive(task, isArchived(task) ? null : Date.now()); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-ink hover:bg-menu-hover disabled:opacity-40">{archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}{archived ? t("task.unarchive") : t("task.archive")}</button>}
      {onSnooze && <div className="px-2 pt-1">
        <span className="flex items-center gap-2 text-[12px] font-medium text-ink-secondary"><Clock size={16} />{t("task.snooze")}</span>
        <div className="mt-0.5 flex flex-col">
          {[{ label: t("task.snoozeUntilActivity"), at: 0 }, { label: t("task.snoozeTonight"), at: nextSixPm() }, { label: t("task.snoozeTomorrow"), at: tomorrowNineAm() }].map((preset) => (
            <button key={preset.label} type="button" disabled={isWorking(task)} onClick={() => { setMenu(null); onSnooze(task, preset.at); }} className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-ink hover:bg-menu-hover disabled:opacity-40">{preset.label}</button>
          ))}
        </div>
      </div>}
      {onSnooze && snoozed && <button type="button" onClick={() => { setMenu(null); onSnooze(task, null); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-ink hover:bg-menu-hover"><BellOff size={16} />{t("task.stopSnoozing")}</button>}
      {onRefreshPermissions && <button type="button" disabled={isWorking(task)} title={t("task.refreshPermissionsHint")} onClick={() => { setMenu(null); onRefreshPermissions(task); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-ink hover:bg-menu-hover disabled:opacity-40"><RefreshCw size={16} />{t("task.refreshPermissions")}</button>}
      <button type="button" disabled={isWorking(task)} onClick={() => { setMenu(null); setDeleting(true); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] leading-[18px] text-danger hover:bg-menu-hover disabled:opacity-40"><Trash2 size={16} />{t("task.deleteAria")}</button>
    </div>, document.body)}
    <ConfirmDialog open={deleting} title={t("task.deleteConfirm")} body={t("task.deleteBody", { title: task.title })} confirmLabel={t("task.deleteAria")}
      onCancel={() => setDeleting(false)} onConfirm={() => { if (!isWorking(task)) onDelete(task); setDeleting(false); }} returnFocusRef={actionRef} />
  </>;
}, sameThreadRow);
