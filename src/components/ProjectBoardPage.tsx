import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FolderPlus, Loader2, Pencil, Plus, RefreshCw, TriangleAlert } from "lucide-react";

import { t, intlLocale } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageActions, ToolPageHeader } from "@/components/ToolPageShell";
import { Select } from "@/components/Select";
import { openThread, useStore, type Bot } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { boardErrorKey, loadBoard, refreshBoardWhenShown, startMilestone, useBoard } from "@/state/board";
import {
  BOARD_PHASE_CLASS, EMPTY_FILTER, MILESTONE_CLASS, MILESTONE_LABEL, PHASE_LABEL, PROJECT_STATUS_CLASS,
  PROJECT_STATUS_LABEL, TASK_STATUS_LABEL, boardTaskTitle, boardTree, botNameOf,
  canEditMilestone, canEditProject, canEditTask, filterBoard, filterIsEmpty, milestoneCounts,
  phaseDistribution, taskCounts, unclassifiedConversations, visibilityKind, visibilityPeople,
  type BoardFilter, type BoardProjectNode, type BoardSubprojectNode,
} from "@/lib/project-board";
import type { BoardMilestone, BoardProject, BoardSnapshot, BoardSubproject, BoardTask } from "../../shared/board";
import { ProjectAssignment } from "./board/ProjectAssignment";
import { TaskRow } from "./board/TaskRow";
import { UnclassifiedPanel } from "./board/UnclassifiedPanel";
import {
  EditProjectDialog, EditSubprojectDialog, MilestoneDecisionDialog, NewConversationDialog, NewMilestoneDialog,
  NewProjectDialog, NewSubprojectDialog,
} from "./board/BoardDialogs";

type Dialog =
  | { kind: "project" }
  | { kind: "editProject"; project: BoardProject }
  | { kind: "subproject"; projectId: string; projectName: string }
  | { kind: "editSubproject"; subproject: BoardSubproject }
  | { kind: "milestone"; projectId: string; subprojectId: string; subprojectName: string }
  | { kind: "milestoneDecision"; id: string; title: string }
  | { kind: "conversation"; projectId: string; subprojectId: string; subprojectName: string; parentThreadId?: string; parentTitle?: string };

export function ProjectBoardPage() {
  const { state, dispatch } = useStore();
  const view = useBoard();
  const showThreads = useShowThreads();
  const [filter, setFilter] = useState<BoardFilter>(EMPTY_FILTER);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [slow, setSlow] = useState(false);
  const back = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void loadBoard();
    return refreshBoardWhenShown();
  }, []);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (view.status !== "loading") return;
    const timer = window.setTimeout(() => setSlow(true), 300);
    return () => window.clearTimeout(timer);
  }, [view.status]);
  useEffect(() => {
    const board = view.board;
    if (!board) return;
    const onlyProject = board.projects.length === 1 ? board.projects[0] : undefined;
    const onlySubproject = board.subprojects.length === 1 ? board.subprojects[0] : undefined;
    setExpanded((current) => {
      const next = new Set(current);
      if (onlyProject) next.add(onlyProject.id);
      if (onlyProject && onlySubproject?.projectId === onlyProject.id) next.add(onlySubproject.id);
      return next.size === current.size ? current : next;
    });
  }, [view.board?.projects.length, view.board?.subprojects.length]);

  const board = view.board;
  const manage = board?.capabilities.manage === true;
  const anyEdit = Boolean(board && (manage || Object.values(board.permissions?.projects ?? {}).some(Boolean)));
  const tree = useMemo(() => (board ? boardTree(board) : null), [board]);
  const filtered = useMemo(
    () => (tree ? filterBoard(tree, filter, (task) => ({
      title: boardTaskTitle(task, state.bots, task.threadId),
      botName: botNameOf(task, state.bots) ?? "",
      projectName: "",
      subprojectName: "",
    })) : null),
    [tree, filter, state.bots],
  );
  const unclassified = useMemo(
    () => (board ? unclassifiedConversations(state.bots.map(botConversations), board) : []),
    [board, state.bots],
  );
  const manageBusy = view.status === "loading" && !board;
  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const openTask = (task: BoardTask) => {
    openThread(dispatch, { botId: task.botId, threadId: task.threadId }, state, showThreads);
  };
  const onConversationCreated = (bot: Bot) => {
    dispatch({ type: "botPatched", bot });
    dispatch({ type: "select", id: bot.id });
    dispatch({ type: "showChat" });
  };
  const summary = useMemo(() => {
    if (!board) return null;
    const local = taskCounts(board.tasks);
    return {
      projects: board.projects.length,
      subprojects: board.subprojects.length,
      done: board.counts?.done ?? local.mainDone,
      main: board.counts?.topLevel ?? local.main,
      accepted: board.milestones.filter((milestone) => milestone.status === "accepted").length,
      milestones: board.milestones.length,
    };
  }, [board]);

  return (
    <ToolPage label={t("board.title")}>
      <ToolPageHeader backLabel={t("automations.back")} onBack={() => dispatch({ type: "showChat" })} backRef={back}>
        <h1 className={TOOL_PAGE_TITLE}>{t("board.title")}</h1>
        <ToolPageActions>
          {board && <span className="hidden text-[11px] text-ink-tertiary sm:inline">{updatedLabel(board.updatedAt)}</span>}
          <button
            type="button"
            onClick={() => void loadBoard({ force: true })}
            disabled={view.status === "loading"}
            title={t("board.reload")}
            aria-label={t("board.reload")}
            className="flex size-8 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus"
          >
            <RefreshCw size={15} className={view.status === "loading" ? "animate-spin" : undefined} />
          </button>
          {manage && board && (
            <button type="button" onClick={() => setDialog({ kind: "project" })} className="ui-button ui-button-primary ui-button-sm">
              <Plus size={14} aria-hidden />{t("board.empty.action")}
            </button>
          )}
        </ToolPageActions>
      </ToolPageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto" data-project-board={view.status} data-board-manage={manage ? "true" : "false"}>
        <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
          {view.status === "error" && !board ? (
            <section role="alert" className="px-6 py-16 text-center">
              <p className="text-[14px] text-ink-secondary">{t(boardErrorKey(view.code))}</p>
              <button type="button" className="ui-button ui-button-primary mt-4" onClick={() => void loadBoard({ force: true })}>{t("common.tryAgain")}</button>
            </section>
          ) : !board ? (
            <div role="status" aria-live="polite" className="flex items-center gap-2 px-2 py-16 text-[13px] text-ink-secondary">
              {slow && <Loader2 size={15} className="animate-spin" />}
              {slow ? t("board.loading") : ""}
            </div>
          ) : (
            <>
              {view.status === "error" && (
                <p role="alert" className="mb-3 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[12px] text-danger">
                  {t(boardErrorKey(view.code))}
                </p>
              )}
              {!manage && (
                <p className="mb-3 text-[12px] text-ink-tertiary">{anyEdit ? t("board.readOnly.partial") : t("board.readOnly")}</p>
              )}

              {summary && (
                <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4" data-board-summary>
                  <Summary label={t("board.summary.projects")} value={`${summary.projects}`} />
                  <Summary label={t("board.summary.subprojects")} value={`${summary.subprojects}`} />
                  <Summary label={t("board.summary.tasks")} value={`${summary.done}/${summary.main}`} />
                  <Summary label={t("board.summary.milestones")} value={`${summary.accepted}/${summary.milestones}`} />
                </div>
              )}

              {board.projects.length === 0 ? (
                <section aria-label={t("board.empty.title")} className="rounded-xl border border-hairline/40 bg-card/40 px-6 py-14 text-center">
                  <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-2xl bg-accent/10 text-accent"><FolderPlus size={20} /></div>
                  <h2 className="text-[15px] font-semibold text-ink">{t("board.empty.title")}</h2>
                  <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-secondary">{manage ? t("board.empty.body") : t("board.empty.member")}</p>
                  {manage && <button type="button" className="ui-button ui-button-primary mt-4" onClick={() => setDialog({ kind: "project" })}>{t("board.empty.action")}</button>}
                </section>
              ) : (
                <>
                  <BoardFilters filter={filter} onChange={setFilter} bots={state.bots} board={board} />
                  {filtered && filtered.shown === 0 && !filterIsEmpty(filter) ? (
                    <section aria-label={t("board.filter.none")} className="rounded-xl border border-hairline/40 bg-card/40 px-6 py-10 text-center">
                      <p className="text-[13px] text-ink-secondary">{t("board.filter.none")}</p>
                      <button type="button" className="ui-button mt-3" onClick={() => setFilter(EMPTY_FILTER)}>{t("board.filter.clear")}</button>
                    </section>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {(filtered?.projects ?? []).map((node) => (
                        <ProjectCard
                          key={node.project.id}
                          node={node}
                          board={board}
                          bots={state.bots}
                          expanded={expanded}
                          onToggle={toggle}
                          filter={filter}
                          filtering={!filterIsEmpty(filter)}
                          visible={!filterIsEmpty(filter) ? filtered?.visible : undefined}
                          onOpen={openTask}
                          onEditProject={() => setDialog({ kind: "editProject", project: node.project })}
                          onAddSubproject={() => setDialog({ kind: "subproject", projectId: node.project.id, projectName: node.project.name })}
                          onEditSubproject={(subproject) => setDialog({ kind: "editSubproject", subproject })}
                          onAddMilestone={(subproject) => setDialog({ kind: "milestone", projectId: node.project.id, subprojectId: subproject.id, subprojectName: subproject.name })}
                          onDecideMilestone={(milestone) => setDialog({ kind: "milestoneDecision", id: milestone.id, title: milestone.title })}
                          onNewConversation={(subproject) => setDialog({ kind: "conversation", projectId: node.project.id, subprojectId: subproject.id, subprojectName: subproject.name })}
                          onNewSubtask={(task, subproject) => setDialog({ kind: "conversation", projectId: node.project.id, subprojectId: subproject.id, subprojectName: subproject.name, parentThreadId: task.threadId, parentTitle: boardTaskTitle(task, state.bots, task.threadId) })}
                        />
                      ))}
                      {filtered && filtered.loose.length > 0 && (
                        <section className="rounded-xl border border-warning/30 bg-warning/6 p-3">
                          <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink"><TriangleAlert size={13} aria-hidden />{t("board.unclassified.title")}</p>
                          <ul className="mt-1">
                            {filtered.loose.map((task) => (
                              <li key={task.threadId} className="flex min-h-9 flex-wrap items-center gap-2 py-1">
                                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{boardTaskTitle(task, state.bots, task.threadId)}</span>
                                <ProjectAssignment botId={task.botId} threadId={task.threadId} variant="row" />
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}
                    </div>
                  )}
                </>
              )}

              <UnclassifiedPanel
                conversations={unclassified}
                board={board}
                onOpen={(conversation) => openThread(dispatch, { botId: conversation.botId, threadId: conversation.threadId }, state, showThreads)}
              />
              <p className="mt-3 text-[11px] text-ink-tertiary">{t("board.note.counts")}</p>
            </>
          )}
        </div>
      </div>

      {dialog?.kind === "project" && <NewProjectDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "editProject" && <EditProjectDialog project={dialog.project} onClose={() => setDialog(null)} />}
      {dialog?.kind === "subproject" && <NewSubprojectDialog projectId={dialog.projectId} projectName={dialog.projectName} onClose={() => setDialog(null)} />}
      {dialog?.kind === "editSubproject" && <EditSubprojectDialog subproject={dialog.subproject} onClose={() => setDialog(null)} />}
      {dialog?.kind === "milestone" && <NewMilestoneDialog projectId={dialog.projectId} subprojectId={dialog.subprojectId} subprojectName={dialog.subprojectName} onClose={() => setDialog(null)} />}
      {dialog?.kind === "milestoneDecision" && <MilestoneDecisionDialog id={dialog.id} title={dialog.title} onClose={() => setDialog(null)} />}
      {dialog?.kind === "conversation" && (
        <NewConversationDialog
          bots={state.bots.filter((bot) => !bot.hidden)}
          projectId={dialog.projectId}
          subprojectId={dialog.subprojectId}
          subprojectName={dialog.subprojectName}
          parentThreadId={dialog.parentThreadId}
          parentTitle={dialog.parentTitle}
          onCreated={onConversationCreated}
          onClose={() => setDialog(null)}
        />
      )}
      {manageBusy && <span className="sr-only" role="status">{t("board.loading")}</span>}
    </ToolPage>
  );
}

function visibilityText(value: BoardSnapshot["projects"][number]["visibility"]): string {
  const kind = visibilityKind(value);
  if (kind === "everyone") return t("board.visibility.everyone");
  if (kind === "admins") return t("board.visibility.admins");
  const people = visibilityPeople(value);
  return people.length <= 2 ? people.join(", ") : `${people.slice(0, 2).join(", ")} +${people.length - 2}`;
}

function botConversations(bot: Bot) {
  return { id: bot.id, name: bot.name, hidden: bot.hidden, threadId: bot.threadId, tasks: bot.tasks };
}

function updatedLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-hairline/35 bg-card/40 px-3 py-2">
      <p className="text-[11px] text-ink-tertiary">{label}</p>
      <p className="mt-0.5 text-[18px] font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}

function BoardFilters({ filter, onChange, bots, board }: {
  filter: BoardFilter; onChange: (next: BoardFilter) => void; bots: readonly Bot[]; board: BoardSnapshot;
}) {
  const owners = [...new Set([...board.tasks.map((task) => task.owner).filter((owner): owner is string => Boolean(owner)), ...bots.map((bot) => bot.name)])].sort();
  const active = !filterIsEmpty(filter);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" role="search" aria-label={t("board.filter.search")}>
      <input
        type="search"
        value={filter.query}
        onChange={(event) => onChange({ ...filter, query: event.target.value })}
        placeholder={t("board.filter.search")}
        aria-label={t("board.filter.search")}
        className="h-8 min-w-0 flex-1 basis-48 rounded-full border border-hairline/40 bg-inset px-3 text-[12.5px] text-ink placeholder:text-ink-tertiary focus:border-focus focus:outline-none"
      />
      <Select aria-label={t("board.filter.owner")} size="sm" value={filter.owner} onChange={(event) => onChange({ ...filter, owner: event.target.value })} className="w-[150px]">
        <option value="">{t("board.filter.allOwners")}</option>
        {owners.map((owner) => <option key={owner} value={owner}>{owner}</option>)}
      </Select>
      <Select aria-label={t("board.filter.status")} size="sm" value={filter.status} onChange={(event) => onChange({ ...filter, status: event.target.value as BoardFilter["status"] })} className="w-[140px]">
        <option value="">{t("board.filter.allStatuses")}</option>
        {(["todo", "in_progress", "review", "done"] as const).map((status) => <option key={status} value={status}>{t(TASK_STATUS_LABEL[status])}</option>)}
      </Select>
      <button type="button" aria-pressed={Boolean(filter.flag)} onClick={() => onChange({ ...filter, flag: filter.flag ? "" : "review" })} className={cn("ui-button ui-button-sm", filter.flag === "review" && "bg-warning/15 text-warning-ink")}>
        {t("board.task.review")}
      </button>
      <button type="button" aria-pressed={filter.flag === "blocked"} onClick={() => onChange({ ...filter, flag: filter.flag === "blocked" ? "" : "blocked" })} className={cn("ui-button ui-button-sm", filter.flag === "blocked" && "bg-danger/12 text-danger")}>
        {t("board.task.blocked")}
      </button>
      {active && <button type="button" onClick={() => onChange(EMPTY_FILTER)} className="text-[12px] font-medium text-accent-text hover:underline">{t("board.filter.clear")}</button>}
    </div>
  );
}

function ProjectCard({ node, board, bots, expanded, onToggle, filter, filtering, visible, onOpen, onEditProject, onAddSubproject, onEditSubproject, onAddMilestone, onDecideMilestone, onNewConversation, onNewSubtask }: {
  node: BoardProjectNode;
  board: BoardSnapshot;
  bots: readonly Bot[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
  filter: BoardFilter;
  filtering: boolean;
  visible?: ReadonlySet<string>;
  onOpen: (task: BoardTask) => void;
  onEditProject: () => void;
  onAddSubproject: () => void;
  onEditSubproject: (subproject: BoardSubproject) => void;
  onAddMilestone: (subproject: BoardSnapshot["subprojects"][number]) => void;
  onDecideMilestone: (milestone: BoardMilestone) => void;
  onNewConversation: (subproject: BoardSnapshot["subprojects"][number]) => void;
  onNewSubtask: (task: BoardTask, subproject: BoardSnapshot["subprojects"][number]) => void;
}) {
  const open = expanded.has(node.project.id) || filtering;
  const allTasks = [...node.tasks, ...node.subprojects.flatMap((subproject) => subproject.tasks)];
  const counts = taskCounts(allTasks);
  const milestones = milestoneCounts([...node.milestones, ...node.subprojects.flatMap((subproject) => subproject.milestones)]);
  const spread = phaseDistribution(allTasks);
  const empty = !node.subprojects.length && !node.tasks.length;
  const canEdit = canEditProject(board, node.project.id);
  const status = node.project.status ?? "active";
  return (
    <section aria-labelledby={`project-${node.project.id}`} data-board-project={node.project.id} data-board-editable={canEdit ? "true" : "false"}
      className="overflow-hidden rounded-xl border border-hairline/40 bg-card/40">
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          onClick={() => onToggle(node.project.id)}
          aria-expanded={open}
          aria-controls={`project-body-${node.project.id}`}
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-ink-tertiary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus"
        >
          <ChevronRight size={15} aria-hidden className={cn("transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 id={`project-${node.project.id}`} className="min-w-0 truncate text-[14px] font-semibold text-ink" title={node.project.name}>{node.project.name}</h2>
            <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[10.5px] font-medium", PROJECT_STATUS_CLASS[status] ?? PROJECT_STATUS_CLASS.active)}>
              {t(PROJECT_STATUS_LABEL[status] ?? PROJECT_STATUS_LABEL.active!)}
            </span>
            <span className="text-[11px] text-ink-tertiary tabular-nums">{counts.mainDone}/{counts.main}</span>
            {milestones.total > 0 && <span className="text-[11px] text-ink-tertiary tabular-nums">{t("board.milestone.accepted")} {milestones.accepted}/{milestones.total}</span>}
          </div>
          <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-ink-tertiary">
            {node.project.owner && <span>{t("board.task.owner")}: <span className="text-ink-secondary">{node.project.owner}</span></span>}
            {node.project.goal && <span className="min-w-0 truncate" title={node.project.goal}>{t("board.detail.goal")}: <span className="text-ink-secondary">{node.project.goal}</span></span>}
            <span data-project-visibility={visibilityKind(node.project.visibility)} title={visibilityText(node.project.visibility)}>
              {t("board.visibility.label")}: <span className="text-ink-secondary">{visibilityText(node.project.visibility)}</span>
            </span>
          </p>
          {node.project.description && <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-ink-secondary">{node.project.description}</p>}
          {spread.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1" aria-label={t("board.project.stageSpread")}>
              {spread.map(({ phase, count }) => (
                <span key={phase} className={cn("inline-flex h-5 items-center rounded-full px-1.5 text-[10.5px] font-medium", BOARD_PHASE_CLASS[phase])}>{t(PHASE_LABEL[phase])} {count}</span>
              ))}
            </div>
          )}
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={onEditProject} title={t("board.dialog.editProject")} aria-label={`${t("board.dialog.editProject")}: ${node.project.name}`}
              className="flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus">
              <Pencil size={13} aria-hidden />
            </button>
            <button type="button" onClick={onAddSubproject} title={t("board.project.addSubproject")} aria-label={`${t("board.project.addSubproject")}: ${node.project.name}`}
              className="flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus">
              <Plus size={14} aria-hidden />
            </button>
          </div>
        )}
      </div>
      <div id={`project-body-${node.project.id}`} hidden={!open}>
        {open && (
          <div className="border-t border-hairline/30 px-3 pb-3">
            {node.project.acceptance && (
              <p className="mt-2 text-[11.5px] leading-relaxed text-ink-tertiary" data-project-acceptance>
                {t("board.detail.acceptance")}: <span className="text-ink-secondary">{node.project.acceptance}</span>
              </p>
            )}
            <p className="mt-1 text-[11px] leading-relaxed text-ink-tertiary" data-project-visibility-note>
              {t(`board.visibility.hint.${visibilityKind(node.project.visibility)}`)}
            </p>
            {node.milestones.length > 0 && (
              <ul aria-label={t("board.project.milestones")} className="mt-2 flex flex-col gap-1">
                {node.milestones.map((milestone) => <MilestoneRow key={milestone.id} milestone={milestone} editable={canEditMilestone(board, milestone.id)} onDecide={() => onDecideMilestone(milestone)} />)}
              </ul>
            )}
            {node.tasks.length > 0 && (
              <ul aria-label={node.project.name} className="mt-1">
                {node.tasks.map((task) => (
                  <TaskRow key={task.threadId} task={task} board={board} bots={bots} title={boardTaskTitle(task, bots, task.threadId)}
                    botName={botNameOf(task, bots)} projectName={node.project.name} subprojectName="" editable={canEditTask(board, task.threadId)} depth={0} onOpen={onOpen} visible={visible} />
                ))}
              </ul>
            )}
            {node.subprojects.map((subproject) => (
              <SubprojectBlock key={subproject.subproject.id} node={subproject} projectName={node.project.name} board={board} bots={bots}
                expanded={expanded} onToggle={onToggle} onOpen={onOpen} onEdit={() => onEditSubproject(subproject.subproject)} onAddMilestone={() => onAddMilestone(subproject.subproject)}
                onDecideMilestone={onDecideMilestone} onNewConversation={() => onNewConversation(subproject.subproject)} onNewSubtask={(task) => onNewSubtask(task, subproject.subproject)} filtering={!filterIsEmpty(filter)} visible={visible} />
            ))}
            {empty && <p className="px-1 py-3 text-[12px] text-ink-tertiary">{t("board.project.emptySubprojects")}</p>}
          </div>
        )}
      </div>
    </section>
  );
}

function SubprojectBlock({ node, projectName, board, bots, expanded, onToggle, onOpen, onEdit, onAddMilestone, onDecideMilestone, onNewConversation, onNewSubtask, filtering, visible }: {
  node: BoardSubprojectNode; projectName: string; board: BoardSnapshot; bots: readonly Bot[]; expanded: Set<string>;
  onToggle: (id: string) => void; onOpen: (task: BoardTask) => void; onEdit: () => void; onAddMilestone: () => void;
  onDecideMilestone: (milestone: BoardMilestone) => void; onNewConversation: () => void; onNewSubtask: (task: BoardTask) => void;
  filtering: boolean; visible?: ReadonlySet<string>;
}) {
  const id = node.subproject.id;
  const open = expanded.has(id) || filtering;
  const counts = taskCounts(node.tasks);
  const milestones = milestoneCounts(node.milestones);
  const canEdit = canEditProject(board, node.subproject.projectId);
  const phase = node.subproject.phase ?? "discovery";
  return (
    <div className="mt-2 rounded-lg border border-hairline/30 bg-app/40" data-board-subproject={id} data-board-editable={canEdit ? "true" : "false"}>
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
        <button type="button" onClick={() => onToggle(id)} aria-expanded={open} aria-controls={`subproject-body-${id}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-start hover:bg-raised/50 focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus">
          <ChevronRight size={13} aria-hidden className={cn("shrink-0 text-ink-tertiary transition-transform motion-reduce:transition-none", open && "rotate-90")} />
          <span className="min-w-0 truncate text-[13px] font-medium text-ink" title={node.subproject.name}>{node.subproject.name}</span>
        </button>
        <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[10.5px] font-medium", BOARD_PHASE_CLASS[phase])} title={node.subproject.phaseEvidence ? `${t("board.subproject.phaseEvidence")}: ${node.subproject.phaseEvidence}` : undefined}>
          {t(PHASE_LABEL[phase])}
        </span>
        {node.subproject.owner && <span className="text-[11px] text-ink-tertiary">{node.subproject.owner}</span>}
        <span className="text-[11px] text-ink-tertiary tabular-nums">{counts.mainDone}/{counts.main}</span>
        {milestones.total > 0 && <span className="text-[11px] text-ink-tertiary tabular-nums">{milestones.accepted}/{milestones.total}</span>}
        {canEdit && (
          <div className="ms-auto flex items-center gap-1">
            <button type="button" onClick={onEdit} title={t("board.dialog.editSubproject")} aria-label={`${t("board.dialog.editSubproject")}: ${node.subproject.name}`}
              className="flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus">
              <Pencil size={12} aria-hidden />
            </button>
            <button type="button" onClick={onNewConversation} title={t("board.subproject.newConversation")} aria-label={`${t("board.subproject.newConversation")}: ${node.subproject.name}`}
              className="flex h-7 items-center gap-1 rounded-full px-2 text-[11.5px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus">
              <Plus size={12} aria-hidden />{t("board.subproject.newConversation")}
            </button>
            <button type="button" onClick={onAddMilestone} title={t("board.subproject.addMilestone")} aria-label={`${t("board.subproject.addMilestone")}: ${node.subproject.name}`}
              className="flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus">
              <FolderPlus size={13} aria-hidden />
            </button>
          </div>
        )}
      </div>
      {node.subproject.deliverable && <p className="px-4 text-[11.5px] leading-relaxed text-ink-tertiary" data-subproject-deliverable>{t("board.dialog.deliverable")}: <span className="text-ink-secondary">{node.subproject.deliverable}</span></p>}
      <div id={`subproject-body-${id}`} hidden={!open}>
        {open && (
          <div className="border-t border-hairline/25 px-2 pb-2">
            {node.subproject.acceptance && (
              <p className="mt-1.5 px-1 text-[11.5px] leading-relaxed text-ink-tertiary" data-subproject-acceptance>
                {t("board.detail.acceptance")}: <span className="text-ink-secondary">{node.subproject.acceptance}</span>
              </p>
            )}
            {node.subproject.phaseEvidence && (
              <p className="mt-1 px-1 text-[11.5px] leading-relaxed text-ink-tertiary" data-subproject-phase-evidence>
                {t("board.subproject.phaseEvidence")}: <span className="text-ink-secondary">{node.subproject.phaseEvidence}</span>
              </p>
            )}
            {node.milestones.length > 0 ? (
              <ul aria-label={t("board.project.milestones")} className="mt-1.5 flex flex-col gap-1">
                {node.milestones.map((milestone) => <MilestoneRow key={milestone.id} milestone={milestone} editable={canEditMilestone(board, milestone.id)} onDecide={() => onDecideMilestone(milestone)} />)}
              </ul>
            ) : <p className="mt-1.5 px-1 text-[11px] text-ink-tertiary">{t("board.subproject.noMilestones")}</p>}
            {node.tasks.length > 0 ? (
              <ul aria-label={node.subproject.name} className="mt-1">
                {node.tasks.map((task) => (
                  <TaskRow key={task.threadId} task={task} board={board} bots={bots} title={boardTaskTitle(task, bots, task.threadId)} botName={botNameOf(task, bots)}
                    projectName={projectName} subprojectName={node.subproject.name} editable={canEditTask(board, task.threadId)} depth={0} onOpen={onOpen} onNewSubtask={canEdit ? onNewSubtask : undefined} visible={visible} />
                ))}
              </ul>
            ) : <p className="mt-1.5 px-1 text-[11px] text-ink-tertiary">{t("board.subproject.noTasks")}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function MilestoneRow({ milestone, editable, onDecide }: { milestone: BoardMilestone; editable: boolean; onDecide: () => void }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await startMilestone(milestone.id);
    } catch {
      setError(t("board.error.invalid"));
    } finally {
      setStarting(false);
    }
  };
  return (
    <li data-board-milestone={milestone.id} className="flex min-h-8 flex-wrap items-center gap-2 rounded-md px-1 py-0.5">
      <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[10.5px] font-medium", MILESTONE_CLASS[milestone.status])}>{t(MILESTONE_LABEL[milestone.status])}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink" title={milestone.verdict ? `${milestone.title} · ${milestone.verdict}` : milestone.title}>{milestone.title}</span>
      {milestone.owner && <span className="shrink-0 text-[11px] text-ink-tertiary">{milestone.owner}</span>}
      {milestone.acceptedBy && <span className="shrink-0 text-[11px] text-ink-tertiary" data-milestone-accepted-by>{t("board.milestone.acceptedBy")}: {milestone.acceptedBy}</span>}
      {milestone.dueAt && <span className="shrink-0 text-[11px] text-ink-tertiary tabular-nums">{new Date(milestone.dueAt).toLocaleDateString(intlLocale(), { month: "short", day: "numeric" })}</span>}
      {editable && milestone.status !== "accepted" && milestone.status !== "rejected" && (
        milestone.status === "planned"
          ? <button type="button" onClick={() => void start()} disabled={starting} className="ui-button ui-button-sm">{starting ? <Loader2 size={12} className="animate-spin" /> : null}{t("board.milestone.start")}</button>
          : <button type="button" onClick={onDecide} className="ui-button ui-button-sm">{t("board.milestone.decide")}</button>
      )}
      {error && <span role="alert" className="text-[11px] text-danger">{error}</span>}
    </li>
  );
}
