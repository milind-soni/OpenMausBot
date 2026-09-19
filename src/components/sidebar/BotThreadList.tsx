import { useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2, Plus } from "lucide-react";
import { api, currentTaskBot, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { draggedFolder, FOLDER_DRAG_TYPE, moveFolder, placeFolder } from "@/lib/folder-order";
import { folderUnreadThreadIds, markFolderRead } from "@/lib/folder-read";
import { BotProjectDialog, FolderActions, FolderIcon, NewThreadButton } from "../BotProjects";
import { isArchived, orderedSidebarThreads, SidebarThreadRow, visibleSidebarThreads } from "../SidebarThreadRow";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { useRevealedThreadRow } from "./useRevealedThreadRow";

/** The thread tree under one bot row: project folders, then ungrouped rows.
 * Visibility folds old threads away; ordering floats attention to the top so
 * the person never hunts for a working thread below newer idle ones. */
export function BotThreadList({ bot, selected, density = "comfortable", query = "", hidden = false }: { bot: Bot; selected: boolean; density?: SidebarDensity; query?: string; hidden?: boolean }) {
  const { state, dispatch } = useStore();
  const tasks = (bot.tasks ?? [{ threadId: bot.threadId, title: t("task.newShort"), createdAt: 0 }])
    .filter((task) => !task.routineRunId)
    .map((task) => ({ ...task, queued: Boolean(state.pendingQueued[task.threadId]?.length) }));
  const projects = bot.projects ?? [];
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ projectId: string; left: number; top: number } | null>(null);
  const [markingRead, setMarkingRead] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [readStatus, setReadStatus] = useState("");
  const [reordering, setReordering] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [reorderStatus, setReorderStatus] = useState("");
  const [folderDrop, setFolderDrop] = useState<{ id: string; place: "before" | "after" } | null>(null);
  const draggingFolder = useRef<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const currentProjectId = tasks.find((task) => task.threadId === bot.threadId)?.projectId;
  useEffect(() => {
    if (selected && currentProjectId) setCollapsed((previous) => {
      if (!previous.has(currentProjectId)) return previous;
      const next = new Set(previous);
      next.delete(currentProjectId);
      return next;
    });
  }, [selected, currentProjectId]);
  // Attention floats within the default list; search keeps relevance order.
  const visibleTasks = query
    ? visibleSidebarThreads(tasks, bot.threadId, query, projects, showAll)
    : orderedSidebarThreads(visibleSidebarThreads(tasks, bot.threadId, "", projects, showAll), bot.threadId);
  // Folders follow their best thread in that same order, so a folder holding
  // a waiting approval outranks one holding only idle history; search keeps
  // relevance order, and the stored order still governs move up and down.
  const visibleProjectIndex = (projectId: string) => {
    const index = visibleTasks.findIndex((task) => task.projectId === projectId);
    return index === -1 ? Infinity : index;
  };
  const orderedProjects = query ? projects : [...projects].sort((a, b) => visibleProjectIndex(a.id) - visibleProjectIndex(b.id));
  useRevealedThreadRow(state.revealThread, selected ? bot.threadId : null);
  const renderThread = (task: (typeof tasks)[number]) => {
    const thread = currentTaskBot(bot, task.threadId);
    return <SidebarThreadRow key={task.threadId} task={{ ...task, busy: thread.busy, activity: thread.activity }} ownerId={bot.id} current={selected && task.threadId === bot.threadId} compact={density === "compact"} folders={projects}
      onSelect={() => { if (task.threadId !== bot.threadId) dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId }); else dispatch({ type: "select", id: bot.id }); }}
      onRename={(title) => dispatch({ type: "renameTask", botId: bot.id, threadId: task.threadId, title })}
      onDelete={() => dispatch({ type: "deleteTask", botId: bot.id, threadId: task.threadId })}
      onMove={(projectId) => dispatch({ type: "updateTask", botId: bot.id, threadId: task.threadId, patch: { projectId } })}
      onArchive={(archivedAt) => dispatch({ type: "updateTask", botId: bot.id, threadId: task.threadId, patch: { archivedAt } })} />;
  };
  const ungrouped = visibleTasks.filter((task) => !projects.some((project) => project.id === task.projectId));
  // The archived disclosure holds only what the default list folds away; an
  // archived thread that demands attention already sits in the rows above.
  const archivedTasks = !query && !showAll
    ? tasks.filter((task) => isArchived(task) && !visibleTasks.some((visible) => visible.threadId === task.threadId))
    : [];
  const projectToEdit = projects.find((project) => project.id === editingProject);
  const projectIds = projects.map((project) => project.id);
  const saveOrder = (ids: string[], onSaved?: () => void) => {
    if (reordering || ids.every((id, index) => id === projectIds[index])) return;
    setReordering(true); setReorderError(null); setReorderStatus(t("folder.reordering"));
    dispatch({ type: "reorderProjects", botId: bot.id, projectIds: ids,
      onSaved: () => { setReordering(false); setReorderStatus(t("folder.reordered")); onSaved?.(); },
      onError: (message) => { setReordering(false); setReorderStatus(""); setReorderError(message); } });
  };
  const resetFolderDrag = () => { draggingFolder.current = null; setFolderDrop(null); };
  const readFolder = async (projectId: string, onSaved: () => void) => {
    if (markingRead) return;
    setMarkingRead(true); setReadError(null); setReadStatus(t("folder.markingRead"));
    try {
      await markFolderRead(bot, projectId, api, (updated) => dispatch({ type: "botPatched", bot: updated }));
      setReadStatus(t("folder.markedRead"));
      onSaved();
    } catch (error) {
      setReadError(error instanceof Error ? error.message : String(error));
      setReadStatus("");
    } finally { setMarkingRead(false); }
  };
  return (
    <div hidden={hidden} className="mb-2 ml-5 space-y-0.5 border-l border-hairline/30 pl-2" role="group" aria-label={t("task.namedList", { name: bot.name })}
      onDragOver={(event) => { if (event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) event.stopPropagation(); }}
      onDrop={(event) => { if (event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) { event.preventDefault(); event.stopPropagation(); resetFolderDrag(); } }}>
      {!hidden && <>
      {orderedProjects.map((project) => {
        const index = projects.indexOf(project);
        const projectTasks = tasks.filter((task) => task.projectId === project.id);
        const visible = visibleTasks.filter((task) => task.projectId === project.id);
        if (query && visible.length === 0 && !project.name.toLowerCase().includes(query.toLowerCase())) return null;
        const open = Boolean(query) || !collapsed.has(project.id);
        const waiting = projectTasks.some((task) => task.activity === "waiting-on-you");
        const working = projectTasks.some((task) => task.busy);
        return <div key={project.id} data-sidebar-project={project.id}>
          <div data-sidebar-folder-row={project.id} draggable={!reordering}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setFolderMenu({ projectId: project.id, left: event.clientX, top: event.clientY }); }}
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(FOLDER_DRAG_TYPE, JSON.stringify({ botId: bot.id, projectId: project.id }));
              draggingFolder.current = project.id;
            }}
            onDragEnd={(event) => { event.stopPropagation(); resetFolderDrag(); }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) return;
              event.stopPropagation();
              if (!draggingFolder.current || reordering) { event.dataTransfer.dropEffect = "none"; return; }
              event.preventDefault(); event.dataTransfer.dropEffect = "move";
              const rect = event.currentTarget.getBoundingClientRect();
              setFolderDrop({ id: project.id, place: event.clientY < rect.top + rect.height / 2 ? "before" : "after" });
            }}
            onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFolderDrop(null); }}
            onDrop={(event) => {
              if (!event.dataTransfer.types.includes(FOLDER_DRAG_TYPE)) return;
              event.preventDefault(); event.stopPropagation();
              const from = draggedFolder(event.dataTransfer.getData(FOLDER_DRAG_TYPE), bot.id, projectIds);
              const rect = event.currentTarget.getBoundingClientRect();
              if (from) saveOrder(placeFolder(projectIds, from, project.id, event.clientY < rect.top + rect.height / 2 ? "before" : "after"));
              resetFolderDrag();
            }}
            className={cn("group/folder flex items-center gap-0.5 rounded-md text-ink-secondary hover:bg-raised/30",
              folderDrop?.id === project.id && draggingFolder.current !== project.id && (folderDrop.place === "before" ? "shadow-[0_-2px_var(--color-accent)]" : "shadow-[0_2px_var(--color-accent)]"))}>
            <button type="button" aria-expanded={open} onClick={() => setCollapsed((previous) => {
              const next = new Set(previous);
              if (next.has(project.id)) next.delete(project.id); else next.add(project.id);
              return next;
            })} className="flex size-6 shrink-0 items-center justify-center rounded outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60" aria-label={t(open ? "task.collapseNamed" : "task.expandNamed", { name: project.name })}>
              <ChevronRight aria-hidden="true" size={11} className={cn("shrink-0 transition-transform", open && "rotate-90")} />
            </button>
            <button type="button" aria-label={t("folder.iconNamed", { name: project.name })} title={t("folder.iconNamed", { name: project.name })} onClick={() => setEditingProject(project.id)} className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-raised"><FolderIcon emoji={project.emoji} size={14} /></button>
            <button type="button" data-sidebar-folder-label={project.id} draggable={!reordering} aria-expanded={open} onClick={() => setCollapsed((previous) => {
              const next = new Set(previous);
              if (next.has(project.id)) next.delete(project.id); else next.add(project.id);
              return next;
            })} className="flex min-h-8 min-w-0 flex-1 cursor-grab select-none items-center gap-1.5 py-1 text-left text-[13px] font-semibold active:cursor-grabbing" title={project.name}>
              <span className="truncate">{project.name}</span>
              <span className="shrink-0 text-[10px] font-normal opacity-50">{projectTasks.length}</span>
              {!open && (waiting ? <span className="text-[10px] text-warning">{t("task.waiting")}</span> : working ? <Loader2 size={10} className="shrink-0 animate-spin text-success" /> : projectTasks.some((task) => task.unread) ? <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unreadMany")} /> : null)}
            </button>
            <button type="button" title={t("task.newIn", { name: project.name })} aria-label={t("task.newIn", { name: project.name })} onClick={() => dispatch({ type: "newTask", botId: bot.id, projectId: project.id })}
              className="flex size-6 items-center justify-center rounded opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover/folder:opacity-100 max-md:opacity-70"><Plus size={12} /></button>
            <FolderActions project={project} canMoveUp={index > 0} canMoveDown={index < projects.length - 1} canMarkRead={folderUnreadThreadIds(bot, project.id).length > 0} saving={reordering || markingRead}
              menu={folderMenu?.projectId === project.id ? folderMenu : null} onMenuChange={(menu) => setFolderMenu(menu ? { ...menu, projectId: project.id } : null)}
              onEdit={() => setEditingProject(project.id)} onMove={(direction, onSaved) => saveOrder(moveFolder(projectIds, project.id, direction), onSaved)}
              onMarkRead={(onSaved) => { void readFolder(project.id, onSaved); }} />
          </div>
          {open && <div className="ml-3 border-l border-hairline/25 pl-2" role="group" aria-label={t("task.namedList", { name: project.name })}>
            {visible.map(renderThread)}
            {projectTasks.length === 0 && <p className="px-2.5 py-1 text-[11px] text-ink-secondary/70">{t("task.empty")}</p>}
          </div>}
        </div>;
      })}
      {reorderError && <p role="alert" className="px-2.5 py-1 text-[12px] text-danger">{reorderError}</p>}
      <span role="status" className="sr-only">{reorderStatus}</span>
      {readError && <p role="alert" className="px-2.5 py-1 text-[12px] text-danger">{readError}</p>}
      <span role="status" className="sr-only">{readStatus}</span>
      {projects.length > 0 && ungrouped.length > 0 && <div className="px-3 pb-1 pt-2 text-[10.5px] text-ink-secondary/70">{t("task.list")}</div>}
      {ungrouped.map(renderThread)}
      {!query && !showAll && tasks.length > visibleTasks.length && <button type="button" onClick={() => setShowAll(true)} className="px-3 py-1.5 text-[11px] text-ink-secondary hover:text-ink">{t("task.showAll", { count: tasks.length })}</button>}
      {archivedTasks.length > 0 && <>
        <button type="button" aria-expanded={showArchived} onClick={() => setShowArchived((previous) => !previous)} className="flex items-center gap-1 px-3 py-1.5 text-[11px] text-ink-secondary hover:text-ink">
          <ChevronRight aria-hidden="true" size={11} className={cn("shrink-0 transition-transform", showArchived && "rotate-90")} />
          {t("task.archivedList", { count: archivedTasks.length })}
        </button>
        {showArchived && archivedTasks.map(renderThread)}
      </>}
      <NewThreadButton bot={bot} className="mt-1 w-full rounded-md" />
      {projectToEdit && <BotProjectDialog bot={bot} project={projectToEdit} onClose={() => setEditingProject(null)} />}
      </>}
    </div>
  );
}

