import { useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, ChevronDown, ChevronRight, ClipboardList, Tag, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { SHARED_HEADER_HEIGHT_CLASS } from "@/lib/layoutTokens";
import { STATUS_ICONS, STATUS_LABELS, PRIORITY_STYLES } from "./TaskBoardScreen";
import type { TaskRecord, TaskStatus } from "@/lib/taskBoard";
import { useStore } from "@/state/store";

const STATUS_ORDER: TaskStatus[] = ["todo", "doing", "review", "done"];

function TaskRow({ task, onOpen }: { task: TaskRecord; onOpen: () => void }) {
  const StatusIcon = STATUS_ICONS[task.status];
  const overdue = task.dueAt !== null && task.dueAt < Date.now() && task.status !== "done";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 rounded-lg border border-hairline/40 bg-panel/60 p-2.5 text-left transition-colors hover:bg-raised/60"
    >
      <div className="flex items-start gap-2">
        <StatusIcon
          size={13}
          className={cn(
            "mt-0.5 shrink-0",
            task.status === "done" ? "text-success" : task.status === "review" ? "text-warning" : "text-accent",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{task.title}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-[21px]">
        <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", PRIORITY_STYLES[task.priority])}>
          {task.priority}
        </span>
        <span className="text-[10px] text-ink-secondary">{STATUS_LABELS[task.status]}</span>
        {task.dueAt !== null && (
          <span className={cn("flex items-center gap-1 text-[10px]", overdue ? "text-danger" : "text-ink-secondary")}>
            {overdue ? <AlertTriangle size={10} /> : <CalendarDays size={10} />}
            {overdue ? "Overdue" : new Date(task.dueAt).toLocaleDateString()}
          </span>
        )}
        {task.tags.slice(0, 2).map((tag) => (
          <span key={tag} className="flex items-center gap-0.5 text-[10px] text-ink-secondary">
            <Tag size={9} />
            {tag}
          </span>
        ))}
      </div>
    </button>
  );
}

export function TasksPanel({
  tasks,
  emptyLabel,
  onClose,
  className,
  headerExtra,
}: {
  tasks: TaskRecord[];
  emptyLabel: string;
  onClose?: () => void;
  className?: string;
  /** e.g. the room's project picker, shown under the header */
  headerExtra?: React.ReactNode;
}) {
  const { dispatch } = useStore();
  const openTask = () => dispatch({ type: "toggleTaskBoard", open: true });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggleStatus = (status: string) => {
    setCollapsed((prev) => ({ ...prev, [status]: !prev[status] }));
  };

  const tasksByStatus = useMemo(() => {
    const groups: Record<TaskStatus, TaskRecord[]> = {
      todo: [],
      doing: [],
      review: [],
      done: [],
    };
    for (const task of tasks) {
      if (groups[task.status]) {
        groups[task.status].push(task);
      }
    }
    return groups;
  }, [tasks]);

  return (
    <aside className={cn("flex h-full w-[320px] max-w-full shrink-0 flex-col border-l border-hairline/40 bg-panel", className)} aria-label="Tasks">
      <div className="shrink-0">
        <div className={cn("flex items-center justify-between px-4 border-b border-hairline/40", SHARED_HEADER_HEIGHT_CLASS)}>
          <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
            <ClipboardList size={16} className="text-accent" /> Tasks
            {tasks.length > 0 && (
              <span className="rounded-full bg-raised px-1.5 py-0.5 text-[10px] font-normal text-ink-secondary">{tasks.length}</span>
            )}
          </div>
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Close tasks panel" className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink">
              <X size={16} />
            </button>
          )}
        </div>
        {headerExtra && <div className="px-4 pb-3 border-b border-hairline/40">{headerExtra}</div>}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {tasks.length === 0 ? (
          <div className="py-10 text-center text-[12.5px] text-ink-secondary">{emptyLabel}</div>
        ) : (
          <div className="flex flex-col gap-4">
            {STATUS_ORDER.map((status) => {
              const groupTasks = tasksByStatus[status];
              if (groupTasks.length === 0) return null;
              const isCollapsed = Boolean(collapsed[status]);
              const StatusIcon = STATUS_ICONS[status];
              return (
                <div key={status} className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => toggleStatus(status)}
                    className="flex w-full items-center justify-between px-1 py-1 text-[12px] font-semibold text-ink-secondary hover:text-ink transition-colors"
                  >
                    <div className="flex items-center gap-1.5">
                      {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      <StatusIcon
                        size={13}
                        className={cn(
                          status === "done" ? "text-success" : status === "review" ? "text-warning" : status === "doing" ? "text-accent" : "text-ink-secondary"
                        )}
                      />
                      <span>{STATUS_LABELS[status]}</span>
                    </div>
                    <span className="rounded-full bg-raised px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary">
                      {groupTasks.length}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="flex flex-col gap-2">
                      {groupTasks.map((task) => (
                        <TaskRow key={task.id} task={task} onOpen={openTask} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
