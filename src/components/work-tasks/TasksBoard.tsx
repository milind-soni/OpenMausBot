import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  ExternalLink,
  FileCheck2,
  GitBranch,
  MessageSquare,
  Plus,
  Search,
  Settings2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import {
  AGENT_TASK_PRIORITIES,
  AGENT_TASK_STATUSES,
  AGENT_TASK_TYPES,
  BOARD_COLUMNS,
  boardColumnForStatus,
  canTransitionWorkTask,
  type AgentTask,
  type AgentTaskPriority,
  type AgentTaskStatus,
  type AgentTaskType,
  type RoomJiraPublicConfig,
} from "../../../shared/work-tasks";
import { BotAvatar } from "../Avatar";

export interface BoardFilters {
  q: string;
  assigneeBotId: string;
  role: string;
  status: AgentTaskStatus | "";
  type: AgentTaskType | "";
  priority: AgentTaskPriority | "";
  overdueOnly: boolean;
}

const PRIORITY_CLASS: Record<AgentTaskPriority, string> = {
  lowest: "bg-raised text-ink-tertiary",
  low: "bg-raised text-ink-secondary",
  medium: "bg-accent/10 text-accent-text",
  high: "bg-warning/15 text-warning",
  highest: "bg-danger/15 text-danger",
};

function formatDeadline(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function TasksBoard({
  tasks,
  members,
  filters,
  jiraConfig,
  onChangeFilters,
  onResetFilters,
  onOpenNewTask,
  onOpenJiraSettings,
  onSelectTask,
  onMoveTask,
  onOpenThread,
  boardError,
  onDismissError,
}: {
  tasks: AgentTask[];
  members: Bot[];
  filters: BoardFilters;
  jiraConfig: RoomJiraPublicConfig | null;
  onChangeFilters: (patch: Partial<BoardFilters>) => void;
  onResetFilters: () => void;
  onOpenNewTask: () => void;
  onOpenJiraSettings: () => void;
  onSelectTask: (taskId: string) => void;
  onMoveTask: (task: AgentTask, toStatus: AgentTaskStatus) => void;
  onOpenThread: (task: AgentTask) => void;
  boardError: string | null;
  onDismissError: () => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<AgentTaskStatus | null>(null);

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const roles = useMemo(() => {
    const set = new Set<string>();
    for (const m of members) if (m.title?.trim()) set.add(m.title.trim());
    for (const item of tasks) if (item.assigneeRole?.trim()) set.add(item.assigneeRole.trim());
    return [...set];
  }, [members, tasks]);

  const now = Date.now();
  const filteredTasks = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return tasks.filter((task) => {
      if (filters.assigneeBotId && task.assigneeBotId !== filters.assigneeBotId) return false;
      if (filters.role && !(task.assigneeRole ?? "").toLowerCase().includes(filters.role.toLowerCase())) {
        return false;
      }
      if (filters.status) {
        if (filters.status === "blocked") {
          if (task.status !== "blocked" && task.status !== "failed") return false;
        } else if (task.status !== filters.status) {
          return false;
        }
      }
      if (filters.type && task.type !== filters.type) return false;
      if (filters.priority && task.priority !== filters.priority) return false;
      if (filters.overdueOnly) {
        if (task.dueAt === undefined || task.dueAt >= now || task.status === "done" || task.status === "cancelled") {
          return false;
        }
      }
      if (q) {
        const hay = `${task.key} ${task.title} ${task.assigneeName ?? ""} ${(task.labels ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tasks, filters, now]);

  const draggedTask = useMemo(
    () => (draggingId ? tasks.find((t) => t.id === draggingId) ?? null : null),
    [draggingId, tasks],
  );

  const hasActiveFilter = Boolean(
    filters.q || filters.assigneeBotId || filters.role || filters.status || filters.type || filters.priority || filters.overdueOnly,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar & Filters */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary" />
            <input
              type="search"
              value={filters.q}
              onChange={(e) => onChangeFilters({ q: e.target.value })}
              placeholder={t("workTasks.filter.searchPlaceholder")}
              className="w-48 rounded-lg border border-hairline bg-inset py-1 pl-7 pr-2.5 text-[12px] text-ink placeholder:text-ink-tertiary focus:border-focus focus:outline-none"
            />
          </div>

          <select
            aria-label={t("workTasks.filter.agent")}
            value={filters.assigneeBotId}
            onChange={(e) => onChangeFilters({ assigneeBotId: e.target.value })}
            className="rounded-lg border border-hairline bg-control px-2 py-1 text-[12px] text-ink"
          >
            <option value="">{t("workTasks.filter.allAgents")}</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>

          {roles.length > 0 && (
            <select
              aria-label={t("workTasks.filter.role")}
              value={filters.role}
              onChange={(e) => onChangeFilters({ role: e.target.value })}
              className="rounded-lg border border-hairline bg-control px-2 py-1 text-[12px] text-ink"
            >
              <option value="">{t("workTasks.filter.allRoles")}</option>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}

          <select
            aria-label={t("workTasks.filter.status")}
            value={filters.status}
            onChange={(e) => onChangeFilters({ status: e.target.value as AgentTaskStatus | "" })}
            className="rounded-lg border border-hairline bg-control px-2 py-1 text-[12px] text-ink"
          >
            <option value="">{t("workTasks.filter.allStatuses")}</option>
            {AGENT_TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`workTasks.status.${s}` as any)}
              </option>
            ))}
          </select>

          <select
            aria-label={t("workTasks.filter.type")}
            value={filters.type}
            onChange={(e) => onChangeFilters({ type: e.target.value as AgentTaskType | "" })}
            className="rounded-lg border border-hairline bg-control px-2 py-1 text-[12px] text-ink"
          >
            <option value="">{t("workTasks.filter.allTypes")}</option>
            {AGENT_TASK_TYPES.map((tp) => (
              <option key={tp} value={tp}>
                {t(`workTasks.type.${tp}` as any)}
              </option>
            ))}
          </select>

          <select
            aria-label={t("workTasks.filter.priority")}
            value={filters.priority}
            onChange={(e) => onChangeFilters({ priority: e.target.value as AgentTaskPriority | "" })}
            className="rounded-lg border border-hairline bg-control px-2 py-1 text-[12px] text-ink"
          >
            <option value="">{t("workTasks.filter.allPriorities")}</option>
            {AGENT_TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(`workTasks.priority.${p}` as any)}
              </option>
            ))}
          </select>

          {hasActiveFilter && (
            <button
              type="button"
              onClick={onResetFilters}
              className="rounded-lg px-2 py-1 text-[12px] text-accent-text hover:underline"
            >
              {t("workTasks.filter.clear")}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenJiraSettings}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-control px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover"
          >
            <Settings2 size={13} />
            <span>Jira</span>
            {jiraConfig?.enabled && (
              <span
                className={cn(
                  "size-2 rounded-full",
                  jiraConfig.lastError ? "bg-danger" : "bg-success",
                )}
              />
            )}
          </button>

          <button
            type="button"
            onClick={onOpenNewTask}
            className="inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-1 text-[12px] font-medium text-app hover:opacity-90"
          >
            <Plus size={14} />
            <span>{t("workTasks.create.button")}</span>
          </button>
        </div>
      </div>

      {boardError && (
        <div className="mx-4 mt-2 flex items-center justify-between gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          <span>{boardError}</span>
          <button type="button" onClick={onDismissError} className="underline">
            {t("common.close")}
          </button>
        </div>
      )}

      {/* 6-column Kanban Board */}
      <div className="grid min-h-0 flex-1 grid-cols-6 gap-3 overflow-x-auto p-4">
        {BOARD_COLUMNS.map((col) => {
          const colTasks = filteredTasks
            .filter((t) =>
              filters.status === "cancelled"
                ? t.status === "cancelled"
                : t.status !== "cancelled" && boardColumnForStatus(t.status) === col,
            )
            .sort((a, b) => {
              // Surface rework/failed cards at top of their column
              const aSpecial = a.status === "rework" || a.status === "failed" ? 0 : 1;
              const bSpecial = b.status === "rework" || b.status === "failed" ? 0 : 1;
              if (aSpecial !== bSpecial) return aSpecial - bSpecial;
              return b.updatedAt - a.updatedAt;
            });

          const canDrop = draggedTask ? canTransitionWorkTask(draggedTask.status, col) && draggedTask.status !== col : false;
          const isOver = dragOverCol === col;

          return (
            <div
              key={col}
              data-board-column={col}
              onDragOver={(e) => {
                if (!draggedTask) return;
                e.preventDefault();
                if (dragOverCol !== col) setDragOverCol(col);
              }}
              onDragLeave={() => {
                if (dragOverCol === col) setDragOverCol(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverCol(null);
                if (!draggedTask) return;
                onMoveTask(draggedTask, col);
                setDraggingId(null);
              }}
              className={cn(
                "flex min-h-[260px] min-w-[220px] flex-col rounded-xl border bg-panel/70 transition-colors",
                isOver && canDrop
                  ? "border-accent bg-accent/5"
                  : isOver && !canDrop
                    ? "border-danger/60 bg-danger/5"
                    : "border-hairline",
              )}
            >
              <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
                <span className="text-[12px] font-semibold text-ink">
                  {t(`workTasks.status.${col}` as any)}
                </span>
                <span className="rounded-full bg-raised px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-secondary">
                  {colTasks.length}
                </span>
              </div>

              <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                {colTasks.map((task) => {
                  const assignee = task.assigneeBotId ? memberById.get(task.assigneeBotId) : undefined;
                  const runtimeWorking = Boolean(assignee?.busy && task.status === "in-progress");
                  const isOverdue = Boolean(
                    task.dueAt && task.dueAt < now && task.status !== "done" && task.status !== "cancelled",
                  );
                  const jiraLink = task.externalLinks?.find((l) => l.provider === "jira");
                  const jiraKey = task.jiraSync?.issueKey ?? jiraLink?.key;
                  const depCount = task.dependencies?.length ?? 0;
                  const evCount = task.evidence?.length ?? 0;

                  return (
                    <div
                      key={task.id}
                      draggable
                      onDragStart={() => setDraggingId(task.id)}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDragOverCol(null);
                      }}
                      onClick={() => onSelectTask(task.id)}
                      data-task-key={task.key}
                      className={cn(
                        "group cursor-pointer rounded-xl border border-hairline bg-card p-2.5 text-left transition-colors hover:border-edge hover:bg-raised",
                        draggingId === task.id && "opacity-60",
                      )}
                    >
                      {/* Key, type, priority */}
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[11px] font-semibold text-ink-secondary">
                            {task.key}
                          </span>
                          <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] uppercase text-ink-tertiary">
                            {task.type}
                          </span>
                        </div>
                        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", PRIORITY_CLASS[task.priority])}>
                          {t(`workTasks.priority.${task.priority}` as any)}
                        </span>
                      </div>

                      {/* Special status pill when hosted inside a column */}
                      {(task.status === "rework" || task.status === "failed" || task.status === "cancelled") && (
                        <div className="mt-1.5">
                          <span
                            className={cn(
                              "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                              task.status === "rework"
                                ? "bg-warning/15 text-warning"
                                : task.status === "failed"
                                  ? "bg-danger/15 text-danger"
                                  : "bg-raised text-ink-tertiary",
                            )}
                          >
                            {t(`workTasks.status.${task.status}` as any)}
                          </span>
                        </div>
                      )}

                      {/* Title */}
                      <div className="mt-1.5 line-clamp-2 text-[13px] font-medium leading-snug text-ink">
                        {task.title}
                      </div>

                      {/* Needs user warning */}
                      {task.needsUserAction && (
                        <div className="mt-1.5 flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning">
                          <AlertTriangle size={11} className="shrink-0" />
                          <span className="truncate">{task.needsUserReason || t("workTasks.card.needsUser")}</span>
                        </div>
                      )}

                      {/* Assignee & Runtime */}
                      <div className="mt-2 flex items-center justify-between gap-1.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {assignee && (
                            <BotAvatar bot={assignee} state={runtimeWorking ? "working" : "happy"} size={16} animated={false} />
                          )}
                          <span className="truncate text-[11px] font-medium text-ink">
                            {task.assigneeName ?? t("workTasks.unassigned")}
                          </span>
                          {task.assigneeRole && (
                            <span className="truncate text-[10px] text-ink-tertiary">· {task.assigneeRole}</span>
                          )}
                        </div>
                        {runtimeWorking && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-accent-text">
                            <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                            {t("workTasks.card.running")}
                          </span>
                        )}
                      </div>

                      {/* Footer meta: Jira, deadline, deps, evidence, thread jump */}
                      {(jiraKey || task.dueAt || depCount > 0 || evCount > 0 || task.threadId) && (
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5 border-t border-hairline/60 pt-1.5 text-[10px] text-ink-tertiary">
                          <div className="flex flex-wrap items-center gap-2">
                            {jiraKey && (
                              <span
                                className={cn(
                                  "inline-flex items-center gap-0.5 font-mono",
                                  task.jiraSync?.lastError ? "text-danger" : "text-accent-text",
                                )}
                              >
                                <ExternalLink size={10} />
                                {jiraKey}
                              </span>
                            )}
                            {task.dueAt && (
                              <span className={cn("inline-flex items-center gap-0.5", isOverdue && "font-medium text-danger")}>
                                <Calendar size={10} />
                                {formatDeadline(task.dueAt)}
                              </span>
                            )}
                            {depCount > 0 && (
                              <span className="inline-flex items-center gap-0.5">
                                <GitBranch size={10} />
                                {depCount}
                              </span>
                            )}
                            {evCount > 0 && (
                              <span className="inline-flex items-center gap-0.5">
                                <FileCheck2 size={10} />
                                {evCount}
                              </span>
                            )}
                          </div>

                          {task.threadId && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenThread(task);
                              }}
                              title={t("workTasks.detail.openThread")}
                              className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"
                            >
                              <MessageSquare size={10} />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

