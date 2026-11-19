export type AgentTaskType = "epic" | "task" | "subtask" | "bug";

export type AgentTaskStatus =
  | "backlog"
  | "todo"
  | "in-progress"
  | "blocked"
  | "in-review"
  | "rework"
  | "done"
  | "failed"
  | "cancelled";

export type AgentTaskPriority = "lowest" | "low" | "medium" | "high" | "highest";

export type AgentTaskExternalProvider = "jira" | "github" | "other";

export interface AgentTaskExternalLink {
  provider: AgentTaskExternalProvider;
  key?: string;
  url: string;
}

export type AgentTaskEvidenceType = "file" | "commit" | "test" | "url" | "message";

export interface AgentTaskEvidence {
  id: string;
  type: AgentTaskEvidenceType;
  label: string;
  value: string;
  createdAt: number;
  createdByBotId?: string;
}

export interface AgentTaskJiraSync {
  issueKey?: string;
  issueId?: string;
  projectKey?: string;
  lastSyncedAt?: number;
  lastError?: string;
  lastSyncedFingerprint?: string;
  lastRemoteUpdatedAt?: number;
  lastSyncDirection?: "push" | "pull";
}

export interface AgentTask {
  id: string;
  key: string;
  roomId: string;
  parentTaskId?: string;
  type: AgentTaskType;
  title: string;
  description?: string;
  status: AgentTaskStatus;
  priority: AgentTaskPriority;
  coordinatorBotId?: string;
  assigneeBotId?: string;
  assigneeName?: string;
  assigneeRole?: string;
  qaBotId?: string;
  reporterType: "user" | "agent" | "system";
  reporterId?: string;
  acceptanceCriteria?: string[];
  labels?: string[];
  dueAt?: number;
  estimate?: number;
  threadId?: string;
  assignmentId?: string;
  dependencies?: string[];
  blockedBy?: string[];
  externalLinks?: AgentTaskExternalLink[];
  evidence?: AgentTaskEvidence[];
  needsUserAction?: boolean;
  needsUserReason?: string;
  jiraSync?: AgentTaskJiraSync;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
}

export type TaskActivityType =
  | "created"
  | "assigned"
  | "status-changed"
  | "progress"
  | "comment"
  | "evidence-added"
  | "blocked"
  | "reviewed"
  | "jira-synced"
  | "error";

export interface TaskActivity {
  id: string;
  taskId: string;
  roomId: string;
  type: TaskActivityType;
  actorType: "user" | "agent" | "system";
  actorId?: string;
  actorName?: string;
  actorRole?: string;
  message: string;
  fromStatus?: AgentTaskStatus;
  toStatus?: AgentTaskStatus;
  createdAt: number;
}

export interface RoomJiraPublicConfig {
  enabled: boolean;
  baseUrl: string;
  email: string;
  hasApiToken: boolean;
  projectKey: string;
  issueType: string;
  assigneeCustomFieldId?: string;
  statusMap: Partial<Record<AgentTaskStatus, string>>;
  autoSync: boolean;
  lastSyncedAt?: number;
  lastError?: string;
}

export type WorkTaskActorRole = "user" | "coordinator" | "qa" | "worker" | "observer";

export const AGENT_TASK_TYPES: readonly AgentTaskType[] = ["epic", "task", "subtask", "bug"];
export const AGENT_TASK_STATUSES: readonly AgentTaskStatus[] = [
  "backlog",
  "todo",
  "in-progress",
  "blocked",
  "in-review",
  "rework",
  "done",
  "failed",
  "cancelled",
];
export const AGENT_TASK_PRIORITIES: readonly AgentTaskPriority[] = ["lowest", "low", "medium", "high", "highest"];

export const BOARD_COLUMNS: readonly AgentTaskStatus[] = [
  "backlog",
  "todo",
  "in-progress",
  "blocked",
  "in-review",
  "done",
];

/** Canonical Jira-style workflow transitions enforced on server and UI. */
export const WORK_TASK_TRANSITIONS: Readonly<Record<AgentTaskStatus, readonly AgentTaskStatus[]>> = {
  backlog: ["todo", "cancelled"],
  todo: ["in-progress", "blocked", "backlog", "cancelled"],
  "in-progress": ["blocked", "in-review", "failed", "cancelled"],
  blocked: ["todo", "in-progress", "failed", "cancelled"],
  "in-review": ["rework", "done", "failed", "cancelled"],
  rework: ["in-progress", "blocked", "cancelled"],
  done: ["rework"],
  failed: ["todo", "rework", "in-progress", "cancelled"],
  cancelled: ["backlog", "todo"],
};

export function canTransitionWorkTask(from: AgentTaskStatus, to: AgentTaskStatus): boolean {
  if (from === to) return true;
  return WORK_TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

const QA_ROLE_PATTERN = /\b(qa|quality|review(?:er)?|test(?:er|ing)?|audit(?:or)?)\b/i;

export function isQaBot(
  bot: { id: string; name?: string | null; title?: string | null } | null | undefined,
  task?: Pick<AgentTask, "qaBotId"> | null,
): boolean {
  if (!bot) return false;
  if (task?.qaBotId && task.qaBotId === bot.id) return true;
  return QA_ROLE_PATTERN.test(`${bot.title ?? ""} ${bot.name ?? ""}`);
}

export interface ActorTransitionContext {
  actorType: "user" | "agent" | "system";
  isCoordinator?: boolean;
  isQa?: boolean;
  isAssignee?: boolean;
}

export function canActorTransitionWorkTask(
  ctx: ActorTransitionContext,
  from: AgentTaskStatus,
  to: AgentTaskStatus,
): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: true };
  if (!canTransitionWorkTask(from, to)) {
    return {
      ok: false,
      reason: `Workflow transition "${from}" -> "${to}" is not allowed.`,
    };
  }
  if (ctx.actorType === "user" || ctx.actorType === "system") {
    return { ok: true };
  }
  if (ctx.isCoordinator) {
    return { ok: true };
  }
  // Workers cannot self-approve their own tasks as Done.
  if (to === "done") {
    if (ctx.isQa && from === "in-review") return { ok: true };
    return {
      ok: false,
      reason: "Only QA or Coordinator can move a task from In Review to Done.",
    };
  }
  if (to === "rework" && from === "in-review") {
    if (ctx.isQa) return { ok: true };
    return {
      ok: false,
      reason: "Only QA or Coordinator can request Rework from In Review.",
    };
  }
  if (from === "done") {
    return {
      ok: false,
      reason: "Only Coordinator, QA, or the user can reopen a completed task.",
    };
  }
  if (!ctx.isAssignee) {
    if (ctx.isQa && from === "in-review") {
      return {
        ok: false,
        reason: `QA cannot move a task from "${from}" to "${to}".`,
      };
    }
    return {
      ok: false,
      reason: "Workers can only update tasks assigned to them.",
    };
  }
  const workerTargets: ReadonlySet<AgentTaskStatus> = new Set([
    "in-progress",
    "blocked",
    "in-review",
    "failed",
  ]);
  if (!workerTargets.has(to)) {
    return {
      ok: false,
      reason: `Assigned workers cannot move a task to "${to}".`,
    };
  }
  return { ok: true };
}

/** Which Kanban column visually hosts a task's status (keeps 6-column layout while surfacing Rework/Failed). */
export function boardColumnForStatus(status: AgentTaskStatus): AgentTaskStatus {
  if (status === "rework") return "todo";
  if (status === "failed") return "blocked";
  if (status === "cancelled") return "done";
  return status;
}

export interface AgentWorkloadSummary {
  botId: string;
  name: string;
  role?: string;
  total: number;
  inProgress: number;
  blocked: number;
  inReview: number;
  failed: number;
  busy: boolean;
  hasNoTasks: boolean;
  hasFailures: boolean;
}

export interface RoomWorkTaskOverview {
  total: number;
  backlog: number;
  todo: number;
  inProgress: number;
  blocked: number;
  inReview: number;
  rework: number;
  done: number;
  failed: number;
  cancelled: number;
  overdue: number;
  waitingQa: number;
  byAgent: AgentWorkloadSummary[];
}

export function computeRoomTaskOverview(
  tasks: readonly AgentTask[],
  members: readonly { id: string; name: string; title?: string; busy?: boolean }[],
  now = Date.now(),
): RoomWorkTaskOverview {
  const counts: Record<AgentTaskStatus, number> = {
    backlog: 0,
    todo: 0,
    "in-progress": 0,
    blocked: 0,
    "in-review": 0,
    rework: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  let overdue = 0;
  const agentBuckets = new Map<string, AgentWorkloadSummary>();

  for (const member of members) {
    agentBuckets.set(member.id, {
      botId: member.id,
      name: member.name,
      ...(member.title ? { role: member.title } : {}),
      total: 0,
      inProgress: 0,
      blocked: 0,
      inReview: 0,
      failed: 0,
      busy: Boolean(member.busy),
      hasNoTasks: true,
      hasFailures: false,
    });
  }

  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    if (
      task.dueAt !== undefined &&
      task.dueAt < now &&
      task.status !== "done" &&
      task.status !== "cancelled"
    ) {
      overdue += 1;
    }
    if (task.assigneeBotId) {
      let bucket = agentBuckets.get(task.assigneeBotId);
      if (!bucket) {
        bucket = {
          botId: task.assigneeBotId,
          name: task.assigneeName ?? task.assigneeBotId,
          ...(task.assigneeRole ? { role: task.assigneeRole } : {}),
          total: 0,
          inProgress: 0,
          blocked: 0,
          inReview: 0,
          failed: 0,
          busy: false,
          hasNoTasks: true,
          hasFailures: false,
        };
        agentBuckets.set(task.assigneeBotId, bucket);
      }
      if (task.status !== "cancelled") {
        bucket.total += 1;
        bucket.hasNoTasks = false;
      }
      if (task.status === "in-progress") bucket.inProgress += 1;
      else if (task.status === "blocked") bucket.blocked += 1;
      else if (task.status === "in-review") bucket.inReview += 1;
      else if (task.status === "failed") {
        bucket.failed += 1;
        bucket.hasFailures = true;
      }
    }
  }

  return {
    total: tasks.length,
    backlog: counts.backlog,
    todo: counts.todo,
    inProgress: counts["in-progress"],
    blocked: counts.blocked,
    inReview: counts["in-review"],
    rework: counts.rework,
    done: counts.done,
    failed: counts.failed,
    cancelled: counts.cancelled,
    overdue,
    waitingQa: counts["in-review"],
    byAgent: [...agentBuckets.values()],
  };
}

