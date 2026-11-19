import { useCallback, useEffect, useMemo, useState } from "react";
import { listenLiveFrames } from "@/lib/live-events";
import { useShowThreads } from "@/lib/thread-preferences";
import { openThread, useStore, type Bot, type Group } from "@/state/store";
import {
  canTransitionWorkTask,
  computeRoomTaskOverview,
  type AgentTask,
  type AgentTaskStatus,
  type RoomJiraPublicConfig,
} from "../../../shared/work-tasks";
import { JiraConfigModal } from "./JiraConfigModal";
import { NewTaskModal } from "./NewTaskModal";
import { TaskDetailDrawer } from "./TaskDetailDrawer";
import { TasksBoard, type BoardFilters } from "./TasksBoard";
import { TasksOverviewBar } from "./TasksOverviewBar";
import { fetchRoomJiraConfig, fetchRoomWorkTasks, updateWorkTask } from "./work-tasks-api";

const EMPTY_FILTERS: BoardFilters = {
  q: "",
  assigneeBotId: "",
  role: "",
  status: "",
  type: "",
  priority: "",
  overdueOnly: false,
};

export function RoomTasksWorkspace({
  group,
  members,
  onSwitchToChat,
}: {
  group: Group;
  members: Bot[];
  onSwitchToChat?: () => void;
}) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [jiraConfig, setJiraConfig] = useState<RoomJiraPublicConfig | null>(null);
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [jiraModalOpen, setJiraModalOpen] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [tasksRes, jiraRes] = await Promise.all([
        fetchRoomWorkTasks(group.id),
        fetchRoomJiraConfig(group.id).catch(() => ({ config: null })),
      ]);
      setTasks(tasksRes.tasks);
      if (jiraRes.config) setJiraConfig(jiraRes.config);
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : String(err));
    }
  }, [group.id]);

  useEffect(() => {
    void load();
    return listenLiveFrames({
      onFrame: (frame) => {
        if (frame.kind === "work-task" && frame.groupId === group.id) {
          setTasks((prev) => {
            const idx = prev.findIndex((t) => t.id === frame.task.id);
            return idx >= 0
              ? prev.map((t) => (t.id === frame.task.id ? frame.task : t))
              : [frame.task, ...prev];
          });
        } else if (frame.kind === "work-task.deleted" && frame.groupId === group.id) {
          setTasks((prev) => prev.filter((t) => t.id !== frame.taskId));
          setSelectedTaskId((cur) => (cur === frame.taskId ? null : cur));
        }
      },
      onMissedFrames: () => void load(),
    });
  }, [group.id, load]);

  const overview = useMemo(
    () =>
      computeRoomTaskOverview(
        tasks,
        members.map((m) => ({
          id: m.id,
          name: m.name,
          ...(m.title ? { title: m.title } : {}),
          busy: Boolean(m.busy || group.busyBotId === m.id),
        })),
      ),
    [tasks, members, group.busyBotId],
  );

  const handleMoveTask = async (task: AgentTask, toStatus: AgentTaskStatus) => {
    if (task.status === toStatus) return;
    if (!canTransitionWorkTask(task.status, toStatus)) {
      setBoardError(`Workflow rule: "${task.status}" cannot jump directly to "${toStatus}".`);
      return;
    }
    setBoardError(null);
    try {
      const res = await updateWorkTask(task.id, { status: toStatus });
      setTasks((prev) => prev.map((t) => (t.id === task.id ? res.task : t)));
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleOpenThread = (task: AgentTask) => {
    if (!task.threadId) return;
    const isRoomThread =
      task.threadId === group.threadId ||
      group.tasks?.some((gt) => gt.threadId === task.threadId);
    if (isRoomThread) {
      onSwitchToChat?.();
      return;
    }
    if (task.assigneeBotId) {
      openThread(
        dispatch,
        { botId: task.assigneeBotId, threadId: task.threadId },
        state,
        showThreads,
      );
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      <TasksOverviewBar
        overview={overview}
        members={members}
        activeFilter={{
          status: filters.status,
          overdueOnly: filters.overdueOnly,
          assigneeBotId: filters.assigneeBotId,
        }}
        onSelectFilter={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
      />

      <TasksBoard
        tasks={tasks}
        members={members}
        filters={filters}
        jiraConfig={jiraConfig}
        onChangeFilters={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
        onResetFilters={() => setFilters(EMPTY_FILTERS)}
        onOpenNewTask={() => setNewTaskOpen(true)}
        onOpenJiraSettings={() => setJiraModalOpen(true)}
        onSelectTask={(taskId) => setSelectedTaskId(taskId)}
        onMoveTask={(task, toStatus) => void handleMoveTask(task, toStatus)}
        onOpenThread={handleOpenThread}
        boardError={boardError}
        onDismissError={() => setBoardError(null)}
      />

      {selectedTaskId && (
        <TaskDetailDrawer
          taskId={selectedTaskId}
          allTasks={tasks}
          members={members}
          jiraEnabled={Boolean(jiraConfig?.enabled)}
          onClose={() => setSelectedTaskId(null)}
          onOpenTask={(id) => setSelectedTaskId(id)}
          onOpenThread={handleOpenThread}
          onTaskUpdated={() => void load()}
        />
      )}

      {newTaskOpen && (
        <NewTaskModal
          roomId={group.id}
          members={members}
          existingTasks={tasks}
          onClose={() => setNewTaskOpen(false)}
          onCreated={(created) => {
            setTasks((prev) => (prev.some((t) => t.id === created.id) ? prev : [created, ...prev]));
          }}
        />
      )}

      {jiraModalOpen && jiraConfig && (
        <JiraConfigModal
          roomId={group.id}
          initial={jiraConfig}
          onClose={() => setJiraModalOpen(false)}
          onSaved={(next) => setJiraConfig(next)}
        />
      )}
    </div>
  );
}
