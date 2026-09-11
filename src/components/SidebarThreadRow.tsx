import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderInput, Loader2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { BotProject, Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { nextRename } from "@/lib/rename";
import { ConfirmDialog } from "./ConfirmDialog";

type ThreadRowTask = Pick<Task, "threadId" | "title" | "projectId" | "busy" | "activity" | "unread" | "openedBy"> & { queued?: boolean };

/** "opened by Scout" for a thread a bot started, null for the person's own.
 * Shared by the sidebar row and the All-threads picker so both say it the
 * same quiet way. */
export function threadOpenerLabel(task: Pick<Task, "openedBy">): string | null {
  const name = task.openedBy?.name.trim();
  return name ? t("task.openedBy", { name }) : null;
}

export function visibleSidebarThreads<T extends ThreadRowTask>(tasks: T[], activeId: string, query = "", folders: BotProject[] = [], showAll = false): T[] {
  const needle = query.trim().toLowerCase();
  return tasks.filter((task, index) => needle
    ? task.title.toLowerCase().includes(needle) || folders.some((folder) => folder.id === task.projectId && folder.name.toLowerCase().includes(needle))
    : showAll || index < 6 || task.threadId === activeId || task.activity === "waiting-on-you" || task.activity === "working" || task.busy || task.queued || task.unread);
}

/** One quiet row for bot and group histories. Surface denotes selection;
 * working/waiting/unread remain independent signals, never different cards. */
export function SidebarThreadRow({ task, current, compact, folders, onSelect, onRename, onDelete, onMove }: {
  task: ThreadRowTask;
  current: boolean;
  compact?: boolean;
  folders?: BotProject[];
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onMove?: (folderId: string | null) => void;
}) {
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [deleting, setDeleting] = useState(false);
  const finishing = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const status = task.activity === "waiting-on-you" ? t("task.waiting") : task.busy ? t("chat.activity.working") : task.queued ? t("task.queued") : null;
  const opener = threadOpenerLabel(task);
  const openMenu = (x: number, y: number) => setMenu({ left: Math.max(8, Math.min(x, window.innerWidth - 228)), top: Math.max(8, Math.min(y, window.innerHeight - 190)) });
  const startRename = () => { finishing.current = false; setDraft(task.title); setRenaming(true); setMenu(null); };
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
  return <>
    <div className={cn("group/thread relative flex min-w-0 items-center rounded-md", current ? "bg-raised" : "hover:bg-raised/50")}>
      {renaming ? <input autoFocus value={draft} maxLength={80} aria-label={t("task.renameAria")}
        onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)} onBlur={() => finishRename(true)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finishRename(true); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishRename(false); } }}
        className="m-1 min-w-0 flex-1 rounded border border-accent/50 bg-inset px-2 py-1 text-[12.5px] text-ink outline-none" /> : <button
        type="button" data-sidebar-thread-row={task.threadId} aria-current={current ? "page" : undefined}
        title={`${task.title}${status ? ` · ${status}` : ""}${task.unread ? ` · ${t("task.unread")}` : ""}`}
        onClick={onSelect} onDoubleClick={startRename}
        onContextMenu={(event) => { event.preventDefault(); openMenu(event.clientX, event.clientY); }}
        onKeyDown={(event) => { if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.left, rect.bottom); } }}
        className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md pl-3 pr-1 text-left text-[13px] font-medium outline-none focus-visible:ring-1 focus-visible:ring-accent/60", compact ? "min-h-7 py-1" : "min-h-8 py-1.5", current ? "font-semibold text-ink" : "text-ink-secondary hover:text-ink")}>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("min-w-0 truncate", task.unread && "font-semibold text-ink")}>{task.title}</span>
          {opener && <span className="min-w-0 truncate text-[10.5px] leading-tight text-ink-secondary/80">{opener}</span>}
        </span>
        {task.activity === "waiting-on-you" ? <span className="shrink-0 text-[10px] font-medium text-warning">{t("task.waiting")}</span> : task.busy ? <Loader2 size={11} className="shrink-0 animate-spin text-success" aria-label={t("chat.activity.working")} /> : task.queued ? <span className="shrink-0 text-[10px] text-ink-secondary">{t("task.queued")}</span> : null}
        {task.unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unread")} />}
      </button>}
      <button ref={actionRef} type="button" aria-label={t("task.actions", { title: task.title })} aria-expanded={Boolean(menu)}
        onClick={(event) => { if (menu) { setMenu(null); return; } const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.left, rect.bottom); }}
        className="mr-0.5 flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover/thread:opacity-100 max-md:opacity-70">
        <MoreHorizontal size={13} />
      </button>
    </div>
    {menu && createPortal(<div ref={menuRef} data-thread-overlay role="group" aria-label={t("task.actions", { title: task.title })} style={menu}
      className="fixed z-50 w-[220px] rounded-lg border border-hairline/50 bg-card p-1 shadow-xl"
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(null); actionRef.current?.focus(); } }}>
      <button type="button" onClick={startRename} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12px] text-ink hover:bg-raised"><Pencil size={12} />{t("task.renameAria")}</button>
      {onMove && Boolean(folders?.length) && <label className="block rounded px-2.5 py-2 text-[12px] text-ink"><span className="mb-1 flex items-center gap-2 text-ink-secondary"><FolderInput size={12} />{t("folder.move")}</span>
        <select aria-label={t("folder.moveNamed", { title: task.title })} value={folders?.some((folder) => folder.id === task.projectId) ? task.projectId : ""}
          onChange={(event) => { onMove(event.target.value || null); setMenu(null); }} className="w-full rounded border border-hairline/40 bg-card px-1 py-1 text-ink outline-none">
          <option value="">{t("folder.none")}</option>{folders?.map((folder) => <option key={folder.id} value={folder.id}>{folder.emoji ? `${folder.emoji} ` : ""}{folder.name}</option>)}
        </select>
      </label>}
      <button type="button" disabled={Boolean(task.busy)} onClick={() => { setMenu(null); setDeleting(true); }} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12px] text-danger hover:bg-raised disabled:opacity-40"><Trash2 size={12} />{t("task.deleteAria")}</button>
    </div>, document.body)}
    <ConfirmDialog open={deleting} title={t("task.deleteConfirm")} body={t("task.deleteBody", { title: task.title })} confirmLabel={t("task.deleteAria")}
      onCancel={() => setDeleting(false)} onConfirm={() => { if (!task.busy) onDelete(); setDeleting(false); }} returnFocusRef={actionRef} />
  </>;
}
