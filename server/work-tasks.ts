import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  AGENT_TASK_PRIORITIES,
  AGENT_TASK_STATUSES,
  AGENT_TASK_TYPES,
  canActorTransitionWorkTask,
  type AgentTask,
  type AgentTaskEvidence,
  type AgentTaskEvidenceType,
  type AgentTaskExternalLink,
  type AgentTaskJiraSync,
  type AgentTaskPriority,
  type AgentTaskStatus,
  type AgentTaskType,
  type RoomJiraPublicConfig,
  type TaskActivity,
  type TaskActivityType,
} from "../shared/work-tasks.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { ServerFrame } from "../shared/wire.ts";

export interface WorkTaskActor {
  actorType: "user" | "agent" | "system";
  actorId?: string;
  actorName?: string;
  actorRole?: string;
  isCoordinator?: boolean;
  isQa?: boolean;
}

export interface RoomJiraStoredConfig {
  enabled: boolean;
  baseUrl: string;
  email: string;
  projectKey: string;
  issueType: string;
  assigneeCustomFieldId?: string;
  statusMap: Partial<Record<AgentTaskStatus, string>>;
  autoSync: boolean;
  lastSyncedAt?: number;
  lastError?: string;
}

export interface CreateWorkTaskInput {
  roomId: string;
  parentTaskId?: string;
  type?: AgentTaskType;
  title: string;
  description?: string;
  status?: AgentTaskStatus;
  priority?: AgentTaskPriority;
  coordinatorBotId?: string;
  assigneeBotId?: string;
  assigneeName?: string;
  assigneeRole?: string;
  qaBotId?: string;
  acceptanceCriteria?: string[];
  labels?: string[];
  dueAt?: number;
  estimate?: number;
  threadId?: string;
  assignmentId?: string;
  dependencies?: string[];
  blockedBy?: string[];
  externalLinks?: AgentTaskExternalLink[];
}

export interface UpdateWorkTaskInput {
  title?: string;
  description?: string;
  type?: AgentTaskType;
  status?: AgentTaskStatus;
  statusNote?: string;
  priority?: AgentTaskPriority;
  parentTaskId?: string | null;
  coordinatorBotId?: string | null;
  assigneeBotId?: string | null;
  assigneeName?: string | null;
  assigneeRole?: string | null;
  qaBotId?: string | null;
  acceptanceCriteria?: string[];
  labels?: string[];
  dueAt?: number | null;
  estimate?: number | null;
  threadId?: string | null;
  assignmentId?: string | null;
  dependencies?: string[];
  blockedBy?: string[];
  externalLinks?: AgentTaskExternalLink[];
  needsUserAction?: boolean;
  needsUserReason?: string | null;
  jiraSync?: AgentTaskJiraSync | null;
}

export interface WorkTaskFilter {
  roomId?: string;
  assigneeBotId?: string;
  assigneeRole?: string;
  status?: AgentTaskStatus;
  type?: AgentTaskType;
  priority?: AgentTaskPriority;
  parentTaskId?: string;
  q?: string;
  needsUserAction?: boolean;
  overdue?: boolean;
}

export class WorkTaskError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "WorkTaskError";
    this.status = status;
  }
}

const DEFAULT_KEY_PREFIX = "LOOMA";
const DEFAULT_START_SEQ = 100;
const MAX_ACTIVITIES_PER_TASK = 250;
const MAX_TOTAL_ACTIVITIES = 10_000;

const externalLinkSchema = z.object({
  provider: z.enum(["jira", "github", "other"]),
  key: z.string().max(120).optional(),
  url: z.string().min(1).max(2048),
});

const evidenceSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["file", "commit", "test", "url", "message"]),
  label: z.string().min(1).max(240),
  value: z.string().min(1).max(4000),
  createdAt: z.number().finite(),
  createdByBotId: z.string().optional(),
});

const jiraSyncSchema = z.object({
  issueKey: z.string().optional(),
  issueId: z.string().optional(),
  projectKey: z.string().optional(),
  lastSyncedAt: z.number().finite().optional(),
  lastError: z.string().optional(),
  lastSyncedFingerprint: z.string().optional(),
  lastRemoteUpdatedAt: z.number().finite().optional(),
  lastSyncDirection: z.enum(["push", "pull"]).optional(),
});

const taskSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  roomId: z.string().min(1),
  parentTaskId: z.string().optional(),
  type: z.enum(["epic", "task", "subtask", "bug"]),
  title: z.string().min(1).max(280),
  description: z.string().max(20_000).optional(),
  status: z.enum([
    "backlog",
    "todo",
    "in-progress",
    "blocked",
    "in-review",
    "rework",
    "done",
    "failed",
    "cancelled",
  ]),
  priority: z.enum(["lowest", "low", "medium", "high", "highest"]),
  coordinatorBotId: z.string().optional(),
  assigneeBotId: z.string().optional(),
  assigneeName: z.string().optional(),
  assigneeRole: z.string().optional(),
  qaBotId: z.string().optional(),
  reporterType: z.enum(["user", "agent", "system"]),
  reporterId: z.string().optional(),
  acceptanceCriteria: z.array(z.string().max(1000)).optional(),
  labels: z.array(z.string().max(80)).optional(),
  dueAt: z.number().finite().optional(),
  estimate: z.number().finite().optional(),
  threadId: z.string().optional(),
  assignmentId: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  blockedBy: z.array(z.string()).optional(),
  externalLinks: z.array(externalLinkSchema).optional(),
  evidence: z.array(evidenceSchema).optional(),
  needsUserAction: z.boolean().optional(),
  needsUserReason: z.string().max(1000).optional(),
  jiraSync: jiraSyncSchema.optional(),
  createdAt: z.number().finite(),
  startedAt: z.number().finite().optional(),
  updatedAt: z.number().finite(),
  completedAt: z.number().finite().optional(),
});

const activitySchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  roomId: z.string().min(1),
  type: z.enum([
    "created",
    "assigned",
    "status-changed",
    "progress",
    "comment",
    "evidence-added",
    "blocked",
    "reviewed",
    "jira-synced",
    "error",
  ]),
  actorType: z.enum(["user", "agent", "system"]),
  actorId: z.string().optional(),
  actorName: z.string().optional(),
  actorRole: z.string().optional(),
  message: z.string().min(1).max(4000),
  fromStatus: taskSchema.shape.status.optional(),
  toStatus: taskSchema.shape.status.optional(),
  createdAt: z.number().finite(),
});

const roomJiraConfigSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string(),
  email: z.string(),
  projectKey: z.string(),
  issueType: z.string().default("Task"),
  assigneeCustomFieldId: z.string().optional(),
  statusMap: z.record(z.string(), z.string()).default({}),
  autoSync: z.boolean().default(true),
  lastSyncedAt: z.number().finite().optional(),
  lastError: z.string().optional(),
});

const fileSchema = z.object({
  version: z.literal(1),
  seq: z.number().int().nonnegative(),
  tasks: z.array(taskSchema),
  activities: z.array(activitySchema),
  jiraConfigs: z.record(z.string(), roomJiraConfigSchema).optional(),
});

const secretsFileSchema = z.object({
  version: z.literal(1),
  tokens: z.record(z.string(), z.string()),
});

type PersistedWorkTasks = z.infer<typeof fileSchema>;

const cleanText = (value: unknown, max: number): string =>
  typeof value === "string" ? redactSecretsInText(value).trim().slice(0, max) : "";

function emptyPersisted(): PersistedWorkTasks {
  return {
    version: 1,
    seq: DEFAULT_START_SEQ,
    tasks: [],
    activities: [],
    jiraConfigs: {},
  };
}

export interface WorkTaskStoreOptions {
  file: string;
  secretsFile?: string;
  now?: () => number;
  emit?: (frame: ServerFrame) => void;
  onTaskMutated?: (task: AgentTask, reason: string) => void;
}

export class WorkTaskStore {
  private readonly file: string;
  private readonly secretsFile: string;
  private readonly now: () => number;
  private readonly emit?: (frame: ServerFrame) => void;
  private readonly onTaskMutated?: (task: AgentTask, reason: string) => void;
  private data: PersistedWorkTasks;
  private tokens: Record<string, string> = {};
  private readable = true;

  constructor(options: WorkTaskStoreOptions) {
    this.file = options.file;
    this.secretsFile = options.secretsFile ?? join(dirname(options.file), "work-tasks-secrets.json");
    this.now = options.now ?? Date.now;
    this.emit = options.emit;
    this.onTaskMutated = options.onTaskMutated;
    this.data = this.load();
    this.tokens = this.loadSecrets();
  }

  private load(): PersistedWorkTasks {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (!parsed.success) throw parsed.error;
      return {
        ...parsed.data,
        jiraConfigs: parsed.data.jiraConfigs ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.readable = false;
      }
      return emptyPersisted();
    }
  }

  private loadSecrets(): Record<string, string> {
    try {
      const parsed = secretsFileSchema.safeParse(JSON.parse(readFileSync(this.secretsFile, "utf8")));
      if (!parsed.success) return {};
      return parsed.data.tokens;
    } catch {
      return {};
    }
  }

  private save(): void {
    if (!this.readable) {
      throw new WorkTaskError(500, "Saved work tasks file is unreadable; existing file left untouched.");
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  private saveSecrets(): void {
    mkdirSync(dirname(this.secretsFile), { recursive: true });
    writeFileAtomic(
      this.secretsFile,
      JSON.stringify({ version: 1, tokens: this.tokens }, null, 2),
      { mode: 0o600 },
    );
  }

  private broadcastTask(task: AgentTask): void {
    this.emit?.({ kind: "work-task", groupId: task.roomId, task: structuredClone(task) });
  }

  private broadcastActivity(activity: TaskActivity): void {
    this.emit?.({
      kind: "work-task.activity",
      groupId: activity.roomId,
      taskId: activity.taskId,
      activity: structuredClone(activity),
    });
  }

  private recordActivity(
    task: AgentTask,
    input: {
      type: TaskActivityType;
      actor: WorkTaskActor;
      message: string;
      fromStatus?: AgentTaskStatus;
      toStatus?: AgentTaskStatus;
      at?: number;
    },
  ): TaskActivity {
    const activity: TaskActivity = {
      id: randomUUID(),
      taskId: task.id,
      roomId: task.roomId,
      type: input.type,
      actorType: input.actor.actorType,
      ...(input.actor.actorId ? { actorId: input.actor.actorId } : {}),
      ...(input.actor.actorName ? { actorName: input.actor.actorName } : {}),
      ...(input.actor.actorRole ? { actorRole: input.actor.actorRole } : {}),
      message: cleanText(input.message, 4000) || input.type,
      ...(input.fromStatus ? { fromStatus: input.fromStatus } : {}),
      ...(input.toStatus ? { toStatus: input.toStatus } : {}),
      createdAt: input.at ?? this.now(),
    };
    this.data.activities.push(activity);
    // Bound per-task and total activity logs so disk usage stays bounded.
    const forTask = this.data.activities.filter((a) => a.taskId === task.id);
    if (forTask.length > MAX_ACTIVITIES_PER_TASK) {
      const dropId = forTask[0]!.id;
      const idx = this.data.activities.findIndex((a) => a.id === dropId);
      if (idx !== -1) this.data.activities.splice(idx, 1);
    }
    if (this.data.activities.length > MAX_TOTAL_ACTIVITIES) {
      this.data.activities.splice(0, this.data.activities.length - MAX_TOTAL_ACTIVITIES);
    }
    return activity;
  }

  private findIndex(idOrKey: string): number {
    const raw = idOrKey.trim();
    if (!raw) return -1;
    const upper = raw.toUpperCase();
    return this.data.tasks.findIndex((t) => t.id === raw || t.key.toUpperCase() === upper);
  }

  get(idOrKey: string): AgentTask | undefined {
    const idx = this.findIndex(idOrKey);
    return idx >= 0 ? structuredClone(this.data.tasks[idx]!) : undefined;
  }

  findByAssignmentId(assignmentId: string): AgentTask | undefined {
    const found = this.data.tasks.find((t) => t.assignmentId === assignmentId);
    return found ? structuredClone(found) : undefined;
  }

  findByThreadId(threadId: string): AgentTask | undefined {
    const matches = this.data.tasks.filter((t) => t.threadId === threadId);
    if (!matches.length) return undefined;
    // Prefer active non-terminal tasks if multiple tasks ever shared a standing thread.
    const active = matches.find((t) => !["done", "cancelled"].includes(t.status)) ?? matches[matches.length - 1]!;
    return structuredClone(active);
  }

  findByJiraKey(issueKey: string): AgentTask | undefined {
    const upper = issueKey.trim().toUpperCase();
    const found = this.data.tasks.find(
      (t) =>
        t.jiraSync?.issueKey?.toUpperCase() === upper ||
        t.externalLinks?.some((l) => l.provider === "jira" && l.key?.toUpperCase() === upper),
    );
    return found ? structuredClone(found) : undefined;
  }

  list(filter: WorkTaskFilter = {}): AgentTask[] {
    const now = this.now();
    const q = filter.q?.trim().toLowerCase();
    const roleFilter = filter.assigneeRole?.trim().toLowerCase();
    return this.data.tasks
      .filter((task) => {
        if (filter.roomId && task.roomId !== filter.roomId) return false;
        if (filter.assigneeBotId && task.assigneeBotId !== filter.assigneeBotId) return false;
        if (roleFilter && !(task.assigneeRole ?? "").toLowerCase().includes(roleFilter)) return false;
        if (filter.status && task.status !== filter.status) return false;
        if (filter.type && task.type !== filter.type) return false;
        if (filter.priority && task.priority !== filter.priority) return false;
        if (filter.parentTaskId && task.parentTaskId !== filter.parentTaskId) return false;
        if (filter.needsUserAction && !task.needsUserAction) return false;
        if (filter.overdue) {
          if (task.dueAt === undefined || task.dueAt >= now || task.status === "done" || task.status === "cancelled") {
            return false;
          }
        }
        if (q) {
          const hay = `${task.key} ${task.title} ${task.description ?? ""} ${task.assigneeName ?? ""} ${(task.labels ?? []).join(" ")}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .map((t) => structuredClone(t));
  }

  subtasks(parentTaskId: string): AgentTask[] {
    return this.data.tasks.filter((t) => t.parentTaskId === parentTaskId).map((t) => structuredClone(t));
  }

  hasUnfinishedSubtasks(parentTaskId: string): boolean {
    return this.data.tasks.some(
      (t) =>
        t.parentTaskId === parentTaskId &&
        t.status !== "in-review" &&
        t.status !== "done" &&
        t.status !== "cancelled",
    );
  }

  activities(taskId: string): TaskActivity[] {
    return this.data.activities
      .filter((a) => a.taskId === taskId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => structuredClone(a));
  }

  create(
    input: CreateWorkTaskInput,
    actor: WorkTaskActor,
  ): { task: AgentTask; activities: TaskActivity[] } {
    if (actor.actorType === "agent" && !actor.isCoordinator) {
      // Workers can only create subtasks under an existing task assigned to them, or Coordinator/User creates tasks.
      const parent = input.parentTaskId ? this.get(input.parentTaskId) : undefined;
      if (!parent || parent.assigneeBotId !== actor.actorId) {
        throw new WorkTaskError(403, "Only User or Coordinator can create top-level tasks; workers can only create subtasks under their own active task.");
      }
    }
    const title = cleanText(input.title, 280);
    if (!title) throw new WorkTaskError(400, "Task title is required.");
    const roomId = cleanText(input.roomId, 128);
    if (!roomId) throw new WorkTaskError(400, "roomId is required.");

    const type: AgentTaskType = input.type && AGENT_TASK_TYPES.includes(input.type) ? input.type : input.parentTaskId ? "subtask" : "task";
    const priority: AgentTaskPriority =
      input.priority && AGENT_TASK_PRIORITIES.includes(input.priority) ? input.priority : "medium";
    const initialStatus: AgentTaskStatus =
      input.status && AGENT_TASK_STATUSES.includes(input.status)
        ? input.status
        : input.assigneeBotId
          ? "todo"
          : "backlog";

    if (input.parentTaskId) {
      const parent = this.get(input.parentTaskId);
      if (!parent || parent.roomId !== roomId) {
        throw new WorkTaskError(400, "parentTaskId must reference a task in the same room.");
      }
    }

    this.data.seq += 1;
    const key = `${DEFAULT_KEY_PREFIX}-${this.data.seq}`;
    const now = this.now();
    const task: AgentTask = {
      id: randomUUID(),
      key,
      roomId,
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      type,
      title,
      ...(input.description ? { description: cleanText(input.description, 20_000) } : {}),
      status: initialStatus,
      priority,
      ...(input.coordinatorBotId ? { coordinatorBotId: input.coordinatorBotId } : {}),
      ...(input.assigneeBotId ? { assigneeBotId: input.assigneeBotId } : {}),
      ...(input.assigneeName ? { assigneeName: cleanText(input.assigneeName, 120) } : {}),
      ...(input.assigneeRole ? { assigneeRole: cleanText(input.assigneeRole, 120) } : {}),
      ...(input.qaBotId ? { qaBotId: input.qaBotId } : {}),
      reporterType: actor.actorType,
      ...(actor.actorId ? { reporterId: actor.actorId } : {}),
      ...(input.acceptanceCriteria?.length
        ? { acceptanceCriteria: input.acceptanceCriteria.map((c) => cleanText(c, 1000)).filter(Boolean) }
        : {}),
      ...(input.labels?.length ? { labels: input.labels.map((l) => cleanText(l, 80)).filter(Boolean) } : {}),
      ...(typeof input.dueAt === "number" && Number.isFinite(input.dueAt) ? { dueAt: input.dueAt } : {}),
      ...(typeof input.estimate === "number" && Number.isFinite(input.estimate) ? { estimate: input.estimate } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
      ...(input.dependencies?.length ? { dependencies: [...new Set(input.dependencies)] } : {}),
      ...(input.blockedBy?.length ? { blockedBy: [...new Set(input.blockedBy)] } : {}),
      ...(input.externalLinks?.length ? { externalLinks: input.externalLinks } : {}),
      createdAt: now,
      ...(initialStatus === "in-progress" ? { startedAt: now } : {}),
      updatedAt: now,
      ...(initialStatus === "done" ? { completedAt: now } : {}),
    };

    const createdActs: TaskActivity[] = [];
    this.data.tasks.push(task);

    const who = actor.actorName || (actor.actorType === "user" ? "User" : "System");
    createdActs.push(
      this.recordActivity(task, {
        type: "created",
        actor,
        message: `${who} created ${task.key}: ${task.title}`,
        at: now,
      }),
    );

    if (task.assigneeBotId) {
      const target = task.assigneeName || task.assigneeBotId;
      createdActs.push(
        this.recordActivity(task, {
          type: "assigned",
          actor,
          message: `${who} assigned ${task.key} to ${target}${task.assigneeRole ? ` (${task.assigneeRole})` : ""}`,
          at: now,
        }),
      );
    }

    this.save();
    this.broadcastTask(task);
    for (const act of createdActs) this.broadcastActivity(act);
    this.onTaskMutated?.(structuredClone(task), "created");
    return { task: structuredClone(task), activities: createdActs.map((a) => structuredClone(a)) };
  }

  assign(
    idOrKey: string,
    assignee: {
      assigneeBotId: string;
      assigneeName?: string;
      assigneeRole?: string;
      qaBotId?: string;
      coordinatorBotId?: string;
      threadId?: string;
      assignmentId?: string;
    },
    actor: WorkTaskActor,
  ): AgentTask {
    if (actor.actorType === "agent" && !actor.isCoordinator) {
      throw new WorkTaskError(403, "Only User or Coordinator can assign or reassign tasks.");
    }
    const idx = this.findIndex(idOrKey);
    if (idx < 0) throw new WorkTaskError(404, `Task "${idOrKey}" not found.`);
    const task = this.data.tasks[idx]!;
    const now = this.now();

    task.assigneeBotId = assignee.assigneeBotId;
    if (assignee.assigneeName !== undefined) task.assigneeName = cleanText(assignee.assigneeName, 120);
    if (assignee.assigneeRole !== undefined) task.assigneeRole = cleanText(assignee.assigneeRole, 120);
    if (assignee.qaBotId !== undefined) task.qaBotId = assignee.qaBotId;
    if (assignee.coordinatorBotId !== undefined) task.coordinatorBotId = assignee.coordinatorBotId;
    if (assignee.threadId !== undefined) task.threadId = assignee.threadId;
    if (assignee.assignmentId !== undefined) task.assignmentId = assignee.assignmentId;
    if (task.status === "backlog") {
      task.status = "todo";
    }
    task.updatedAt = now;

    const who = actor.actorName || (actor.actorType === "user" ? "User" : "Coordinator");
    const target = task.assigneeName || task.assigneeBotId;
    const act = this.recordActivity(task, {
      type: "assigned",
      actor,
      message: `${who} assigned ${task.key} to ${target}${task.assigneeRole ? ` (${task.assigneeRole})` : ""}`,
      at: now,
    });

    this.save();
    this.broadcastTask(task);
    this.broadcastActivity(act);
    this.onTaskMutated?.(structuredClone(task), "assigned");
    return structuredClone(task);
  }

  transition(
    idOrKey: string,
    toStatus: AgentTaskStatus,
    actor: WorkTaskActor,
    options: {
      message?: string;
      needsUserAction?: boolean;
      needsUserReason?: string;
      activityType?: TaskActivityType;
    } = {},
  ): AgentTask {
    const idx = this.findIndex(idOrKey);
    if (idx < 0) throw new WorkTaskError(404, `Task "${idOrKey}" not found.`);
    const task = this.data.tasks[idx]!;
    const fromStatus = task.status;

    const check = canActorTransitionWorkTask(
      {
        actorType: actor.actorType,
        isCoordinator: actor.isCoordinator || (actor.actorId !== undefined && task.coordinatorBotId === actor.actorId),
        isQa: actor.isQa || (actor.actorId !== undefined && task.qaBotId === actor.actorId),
        isAssignee: actor.actorId !== undefined && task.assigneeBotId === actor.actorId,
      },
      fromStatus,
      toStatus,
    );
    if (!check.ok) {
      throw new WorkTaskError(403, check.reason);
    }

    if (fromStatus === toStatus) {
      if (options.message) {
        return this.addActivity(
          task.id,
          { type: options.activityType ?? "progress", message: options.message },
          actor,
        );
      }
      return structuredClone(task);
    }

    const now = this.now();
    task.status = toStatus;
    task.updatedAt = now;
    if (toStatus === "in-progress" && task.startedAt === undefined) {
      task.startedAt = now;
    }
    if (toStatus === "done") {
      task.completedAt = now;
      task.needsUserAction = false;
      task.needsUserReason = undefined;
    } else if (toStatus === "rework" || toStatus === "in-progress" || toStatus === "todo") {
      task.completedAt = undefined;
      if (options.needsUserAction === undefined) {
        task.needsUserAction = false;
        task.needsUserReason = undefined;
      }
    }
    if (options.needsUserAction !== undefined) {
      task.needsUserAction = options.needsUserAction;
      task.needsUserReason = options.needsUserReason ? cleanText(options.needsUserReason, 1000) : undefined;
    } else if (toStatus === "blocked" || toStatus === "failed") {
      task.needsUserAction = true;
      if (options.message) task.needsUserReason = cleanText(options.message, 1000);
    }

    const who = actor.actorName || (actor.actorType === "user" ? "User" : "System");
    const defaultMsg =
      toStatus === "rework"
        ? `${who} requested Rework on ${task.key}`
        : `${who} moved ${task.key} from ${fromStatus} to ${toStatus}`;
    const activityType: TaskActivityType =
      options.activityType ??
      (toStatus === "blocked"
        ? "blocked"
        : toStatus === "failed"
          ? "error"
          : (fromStatus === "in-review" && (toStatus === "done" || toStatus === "rework"))
            ? "reviewed"
            : "status-changed");

    const act = this.recordActivity(task, {
      type: activityType,
      actor,
      fromStatus,
      toStatus,
      message: options.message ? `${defaultMsg}: ${options.message}` : defaultMsg,
      at: now,
    });

    this.save();
    this.broadcastTask(task);
    this.broadcastActivity(act);
    this.onTaskMutated?.(structuredClone(task), "status-changed");
    return structuredClone(task);
  }

  update(idOrKey: string, patch: UpdateWorkTaskInput, actor: WorkTaskActor): AgentTask {
    const idx = this.findIndex(idOrKey);
    if (idx < 0) throw new WorkTaskError(404, `Task "${idOrKey}" not found.`);
    const task = this.data.tasks[idx]!;
    const isCoordinator = Boolean(actor.isCoordinator || (actor.actorId && task.coordinatorBotId === actor.actorId));
    const isAssignee = Boolean(actor.actorId && task.assigneeBotId === actor.actorId);
    const isQa = Boolean(actor.isQa || (actor.actorId && task.qaBotId === actor.actorId));

    if (actor.actorType === "agent" && !isCoordinator && !isAssignee && !isQa) {
      throw new WorkTaskError(403, "Workers can only update tasks assigned to them.");
    }

    if (patch.assigneeBotId !== undefined && patch.assigneeBotId !== task.assigneeBotId) {
      if (actor.actorType === "agent" && !isCoordinator) {
        throw new WorkTaskError(403, "Only User or Coordinator can change assignee.");
      }
      if (patch.assigneeBotId === null) {
        task.assigneeBotId = undefined;
        task.assigneeName = undefined;
        task.assigneeRole = undefined;
      } else {
        this.assign(
          task.id,
          {
            assigneeBotId: patch.assigneeBotId,
            assigneeName: patch.assigneeName ?? undefined,
            assigneeRole: patch.assigneeRole ?? undefined,
          },
          actor,
        );
      }
    }

    // Reload reference after potential assign() call
    const current = this.data.tasks[this.findIndex(task.id)]!;
    const fieldChanges: string[] = [];

    if (patch.title !== undefined) {
      const next = cleanText(patch.title, 280);
      if (!next) throw new WorkTaskError(400, "Task title cannot be empty.");
      if (next !== current.title) {
        current.title = next;
        fieldChanges.push("title");
      }
    }
    if (patch.description !== undefined) {
      current.description = cleanText(patch.description, 20_000) || undefined;
    }
    if (patch.type !== undefined && AGENT_TASK_TYPES.includes(patch.type)) {
      current.type = patch.type;
    }
    if (patch.priority !== undefined && AGENT_TASK_PRIORITIES.includes(patch.priority)) {
      if (patch.priority !== current.priority) {
        current.priority = patch.priority;
        fieldChanges.push(`priority=${patch.priority}`);
      }
    }
    if (patch.parentTaskId !== undefined) {
      if (patch.parentTaskId === null) current.parentTaskId = undefined;
      else if (patch.parentTaskId === current.id) throw new WorkTaskError(400, "Task cannot be its own parent.");
      else current.parentTaskId = patch.parentTaskId;
    }
    if (patch.coordinatorBotId !== undefined) current.coordinatorBotId = patch.coordinatorBotId ?? undefined;
    if (patch.qaBotId !== undefined) current.qaBotId = patch.qaBotId ?? undefined;
    if (patch.acceptanceCriteria !== undefined) {
      current.acceptanceCriteria = patch.acceptanceCriteria.map((c) => cleanText(c, 1000)).filter(Boolean);
    }
    if (patch.labels !== undefined) {
      current.labels = patch.labels.map((l) => cleanText(l, 80)).filter(Boolean);
    }
    if (patch.dueAt !== undefined) current.dueAt = patch.dueAt ?? undefined;
    if (patch.estimate !== undefined) current.estimate = patch.estimate ?? undefined;
    if (patch.threadId !== undefined) current.threadId = patch.threadId ?? undefined;
    if (patch.assignmentId !== undefined) current.assignmentId = patch.assignmentId ?? undefined;
    if (patch.dependencies !== undefined) current.dependencies = [...new Set(patch.dependencies)];
    if (patch.blockedBy !== undefined) current.blockedBy = [...new Set(patch.blockedBy)];
    if (patch.externalLinks !== undefined) current.externalLinks = patch.externalLinks;
    if (patch.needsUserAction !== undefined) current.needsUserAction = patch.needsUserAction;
    if (patch.needsUserReason !== undefined) current.needsUserReason = patch.needsUserReason ?? undefined;
    if (patch.jiraSync !== undefined) current.jiraSync = patch.jiraSync ?? undefined;

    current.updatedAt = this.now();

    if (fieldChanges.length > 0) {
      const who = actor.actorName || (actor.actorType === "user" ? "User" : "Agent");
      const act = this.recordActivity(current, {
        type: "progress",
        actor,
        message: `${who} updated ${current.key} (${fieldChanges.join(", ")})`,
        at: current.updatedAt,
      });
      this.save();
      this.broadcastTask(current);
      this.broadcastActivity(act);
    } else {
      this.save();
      this.broadcastTask(current);
    }

    if (patch.status !== undefined && patch.status !== current.status) {
      return this.transition(current.id, patch.status, actor, { message: patch.statusNote });
    }

    this.onTaskMutated?.(structuredClone(current), "updated");
    return structuredClone(current);
  }

  bindRuntime(
    idOrKey: string,
    binding: { threadId?: string; assignmentId?: string; coordinatorBotId?: string },
  ): AgentTask | undefined {
    const idx = this.findIndex(idOrKey);
    if (idx < 0) return undefined;
    const task = this.data.tasks[idx]!;
    if (binding.threadId) task.threadId = binding.threadId;
    if (binding.assignmentId) task.assignmentId = binding.assignmentId;
    if (binding.coordinatorBotId && !task.coordinatorBotId) task.coordinatorBotId = binding.coordinatorBotId;
    task.updatedAt = this.now();
    this.save();
    this.broadcastTask(task);
    return structuredClone(task);
  }

  addActivity(
    idOrKey: string,
    input: { type?: TaskActivityType; message: string },
    actor: WorkTaskActor,
  ): AgentTask {
    const idx = this.findIndex(idOrKey);
    if (idx < 0) throw new WorkTaskError(404, `Task "${idOrKey}" not found.`);
    const task = this.data.tasks[idx]!;
    if (actor.actorType === "agent") {
      const isAllowed =
        actor.isCoordinator ||
        actor.isQa ||
        (actor.actorId !== undefined && task.assigneeBotId === actor.actorId) ||
        (actor.actorId !== undefined && task.coordinatorBotId === actor.actorId);
      if (!isAllowed) {
        throw new WorkTaskError(403, "Workers can only add comments or progress to tasks assigned to them.");
      }
    }
    const msg = cleanText(input.message, 4000);
    if (!msg) throw new WorkTaskError(400, "Activity message is required.");
    const now = this.now();
    task.updatedAt = now;
    const act = this.recordActivity(task, {
      type: input.type ?? "comment",
      actor,
      message: msg,
      at: now,
    });
    this.save();
    this.broadcastTask(task);
    this.broadcastActivity(act);
    if (act.type === "comment" || act.type === "progress" || act.type === "reviewed") {
      this.onTaskMutated?.(structuredClone(task), act.type);
    }
    return structuredClone(task);
  }

  addEvidence(
    idOrKey: string,
    input: { type: AgentTaskEvidenceType; label: string; value: string },
    actor: WorkTaskActor,
  ): AgentTask {
    const idx = this.findIndex(idOrKey);
    if (idx < 0) throw new WorkTaskError(404, `Task "${idOrKey}" not found.`);
    const task = this.data.tasks[idx]!;
    if (actor.actorType === "agent") {
      const isAllowed =
        actor.isCoordinator ||
        actor.isQa ||
        (actor.actorId !== undefined && task.assigneeBotId === actor.actorId);
      if (!isAllowed) {
        throw new WorkTaskError(403, "Workers can only attach evidence to tasks assigned to them.");
      }
    }
    const label = cleanText(input.label, 240);
    const value = cleanText(input.value, 4000);
    if (!label || !value) throw new WorkTaskError(400, "Evidence label and value are required.");
    const now = this.now();
    const item: AgentTaskEvidence = {
      id: randomUUID(),
      type: input.type,
      label,
      value,
      createdAt: now,
      ...(actor.actorType === "agent" && actor.actorId ? { createdByBotId: actor.actorId } : {}),
    };
    task.evidence = [...(task.evidence ?? []), item];
    task.updatedAt = now;
    const who = actor.actorName || (actor.actorType === "user" ? "User" : "Agent");
    const act = this.recordActivity(task, {
      type: "evidence-added",
      actor,
      message: `${who} added ${input.type} evidence: ${label} (${value})`,
      at: now,
    });
    this.save();
    this.broadcastTask(task);
    this.broadcastActivity(act);
    return structuredClone(task);
  }

  setJiraSyncState(
    idOrKey: string,
    jiraSync: AgentTaskJiraSync,
    link?: AgentTaskExternalLink,
    activityNote?: string,
  ): AgentTask | undefined {
    const idx = this.findIndex(idOrKey);
    if (idx < 0) return undefined;
    const task = this.data.tasks[idx]!;
    task.jiraSync = { ...task.jiraSync, ...jiraSync };
    if (link) {
      const rest = (task.externalLinks ?? []).filter(
        (existing) => !(existing.provider === "jira" && existing.key === link.key),
      );
      task.externalLinks = [...rest, link];
    }
    const now = this.now();
    task.updatedAt = now;
    let act: TaskActivity | null = null;
    if (activityNote) {
      act = this.recordActivity(task, {
        type: "jira-synced",
        actor: { actorType: "system", actorName: "Jira Sync" },
        message: activityNote,
        at: now,
      });
    }
    this.save();
    this.broadcastTask(task);
    if (act) this.broadcastActivity(act);
    return structuredClone(task);
  }

  delete(idOrKey: string, actor: WorkTaskActor): boolean {
    if (actor.actorType === "agent" && !actor.isCoordinator) {
      throw new WorkTaskError(403, "Only User or Coordinator can delete a task.");
    }
    const idx = this.findIndex(idOrKey);
    if (idx < 0) return false;
    const [removed] = this.data.tasks.splice(idx, 1);
    this.data.activities = this.data.activities.filter((a) => a.taskId !== removed!.id);
    this.save();
    this.emit?.({ kind: "work-task.deleted", groupId: removed!.roomId, taskId: removed!.id });
    return true;
  }

  getRoomJiraConfig(roomId: string): RoomJiraPublicConfig {
    const stored = this.data.jiraConfigs?.[roomId];
    const token = this.tokens[roomId];
    return {
      enabled: stored?.enabled ?? false,
      baseUrl: stored?.baseUrl ?? "",
      email: stored?.email ?? "",
      hasApiToken: Boolean(token),
      projectKey: stored?.projectKey ?? "",
      issueType: stored?.issueType ?? "Task",
      ...(stored?.assigneeCustomFieldId ? { assigneeCustomFieldId: stored.assigneeCustomFieldId } : {}),
      statusMap: stored?.statusMap ?? {},
      autoSync: stored?.autoSync ?? true,
      ...(stored?.lastSyncedAt ? { lastSyncedAt: stored.lastSyncedAt } : {}),
      ...(stored?.lastError ? { lastError: stored.lastError } : {}),
    };
  }

  getRoomJiraSecrets(roomId: string): { config: RoomJiraStoredConfig | undefined; apiToken: string | undefined } {
    return {
      config: this.data.jiraConfigs?.[roomId] ? structuredClone(this.data.jiraConfigs[roomId]!) : undefined,
      apiToken: this.tokens[roomId],
    };
  }

  saveRoomJiraConfig(
    roomId: string,
    input: Partial<RoomJiraStoredConfig> & { apiToken?: string | null },
  ): RoomJiraPublicConfig {
    const existing = this.data.jiraConfigs?.[roomId];
    const next: RoomJiraStoredConfig = {
      enabled: input.enabled ?? existing?.enabled ?? false,
      baseUrl: (input.baseUrl ?? existing?.baseUrl ?? "").trim().replace(/\/+$/, ""),
      email: (input.email ?? existing?.email ?? "").trim(),
      projectKey: (input.projectKey ?? existing?.projectKey ?? "").trim().toUpperCase(),
      issueType: (input.issueType ?? existing?.issueType ?? "Task").trim() || "Task",
      ...(input.assigneeCustomFieldId !== undefined
        ? input.assigneeCustomFieldId.trim()
          ? { assigneeCustomFieldId: input.assigneeCustomFieldId.trim() }
          : {}
        : existing?.assigneeCustomFieldId
          ? { assigneeCustomFieldId: existing.assigneeCustomFieldId }
          : {}),
      statusMap: input.statusMap ?? existing?.statusMap ?? {},
      autoSync: input.autoSync ?? existing?.autoSync ?? true,
      ...(input.lastSyncedAt !== undefined
        ? { lastSyncedAt: input.lastSyncedAt }
        : existing?.lastSyncedAt
          ? { lastSyncedAt: existing.lastSyncedAt }
          : {}),
      ...(input.lastError !== undefined
        ? input.lastError
          ? { lastError: input.lastError }
          : {}
        : existing?.lastError
          ? { lastError: existing.lastError }
          : {}),
    };
    this.data.jiraConfigs = { ...this.data.jiraConfigs, [roomId]: next };
    this.save();

    if (input.apiToken !== undefined) {
      if (input.apiToken === null || input.apiToken === "") {
        delete this.tokens[roomId];
      } else {
        this.tokens[roomId] = input.apiToken.trim();
      }
      this.saveSecrets();
    }
    return this.getRoomJiraConfig(roomId);
  }

  /** Evaluates Telegram Bridge control-plane commands (`/tasks`, `/task`, `/blocked`, `/status`). */
  formatTelegramCommand(
    rawCommand: string,
    rooms: readonly { id: string; name: string }[],
    roomId?: string,
  ): { ok: boolean; command: string; text: string; data?: unknown } {
    const trimmed = rawCommand.trim();
    const parts = trimmed.split(/\s+/);
    const cmd = (parts[0] ?? "").toLowerCase();
    const arg = parts.slice(1).join(" ").trim();
    const targetRooms = roomId ? rooms.filter((r) => r.id === roomId) : rooms;
    const roomTasks = (rid: string) => this.list({ roomId: rid });
    const latestActivityLine = (taskId: string) => {
      const acts = this.activities(taskId);
      const last = acts.at(-1);
      return last?.message ?? "";
    };
    const statusLabel = (status: AgentTaskStatus): string => {
      const map: Record<AgentTaskStatus, string> = {
        backlog: "Backlog",
        todo: "To Do",
        "in-progress": "In Progress",
        blocked: "Blocked",
        "in-review": "In Review",
        rework: "Rework",
        done: "Done",
        failed: "Failed",
        cancelled: "Cancelled",
      };
      return map[status];
    };

    if (cmd === "/task" && arg) {
      const task = this.get(arg);
      if (!task) {
        return { ok: false, command: cmd, text: `Task "${arg}" not found.` };
      }
      const acts = this.activities(task.id).slice(-5);
      const lines = [
        `${task.key}: ${task.title}`,
        `Trạng thái: ${statusLabel(task.status)} | Priority: ${task.priority} | Type: ${task.type}`,
        `Phụ trách: ${task.assigneeName ?? "Chưa gán"}${task.assigneeRole ? ` (${task.assigneeRole})` : ""}`,
        ...(task.needsUserAction && task.needsUserReason ? [`Cần xử lý: ${task.needsUserReason}`] : []),
        ...(task.jiraSync?.issueKey ? [`Jira: ${task.jiraSync.issueKey}`] : []),
        ...(acts.length ? ["", "Hoạt động gần nhất:", ...acts.map((a) => `- ${a.message}`)] : []),
      ];
      return { ok: true, command: cmd, text: lines.join("\n"), data: { task, activities: acts } };
    }

    if (cmd === "/blocked") {
      const blocked = this.list(roomId ? { roomId } : {}).filter(
        (t) => t.status === "blocked" || t.status === "failed",
      );
      if (!blocked.length) {
        return { ok: true, command: cmd, text: "Không có Task nào đang bị Blocked hoặc Failed.", data: { tasks: [] } };
      }
      const lines = [
        `Danh sách Task Blocked / Failed (${blocked.length}):`,
        ...blocked.map((t) => {
          const reason = t.needsUserReason || latestActivityLine(t.id);
          return `- ${t.key} [${statusLabel(t.status)}] ${t.title} (${t.assigneeName ?? "Unassigned"})${reason ? `\n  Chờ: ${reason}` : ""}`;
        }),
      ];
      return { ok: true, command: cmd, text: lines.join("\n"), data: { tasks: blocked } };
    }

    if (cmd === "/tasks") {
      const list = this.list(roomId ? { roomId } : {}).filter((t) => {
        if (!arg) return true;
        const needle = arg.toLowerCase();
        return (
          (t.assigneeName ?? "").toLowerCase().includes(needle) ||
          (t.assigneeBotId ?? "").toLowerCase() === needle ||
          (t.assigneeRole ?? "").toLowerCase().includes(needle)
        );
      });
      if (!list.length) {
        return {
          ok: true,
          command: cmd,
          text: arg ? `Không tìm thấy Task nào cho "${arg}".` : "Chưa có Task nào.",
          data: { tasks: [] },
        };
      }
      const lines = [
        arg ? `Tasks của ${arg} (${list.length}):` : `Tất cả Tasks (${list.length}):`,
        ...list.map(
          (t) =>
            `- ${t.key} [${statusLabel(t.status)}] ${t.title} — ${t.assigneeName ?? "Unassigned"}${t.assigneeRole ? ` (${t.assigneeRole})` : ""}`,
        ),
      ];
      return { ok: true, command: cmd, text: lines.join("\n"), data: { tasks: list } };
    }

    if (cmd === "/status" || cmd === "") {
      const sections: string[] = [];
      for (const room of targetRooms) {
        const tasks = roomTasks(room.id).filter((t) => t.status !== "cancelled");
        if (!tasks.length && targetRooms.length > 1) continue;
        const byAgent = new Map<string, AgentTask[]>();
        for (const task of tasks) {
          const agentLabel = task.assigneeName || task.assigneeBotId || "Unassigned";
          const arr = byAgent.get(agentLabel) ?? [];
          arr.push(task);
          byAgent.set(agentLabel, arr);
        }
        const roomLines: string[] = [room.name];
        if (!byAgent.size) {
          roomLines.push("- Chưa có Task nào.");
        } else {
          for (const [agentName, agentTasks] of byAgent) {
            roomLines.push("");
            roomLines.push(agentName);
            for (const task of agentTasks) {
              roomLines.push(`- ${task.key}: ${statusLabel(task.status)}`);
              const note = task.status === "blocked" && task.needsUserReason
                ? `Chờ: ${task.needsUserReason}`
                : latestActivityLine(task.id)
                  ? `Hoạt động: ${latestActivityLine(task.id)}`
                  : "";
              if (note) roomLines.push(`- ${note}`);
            }
          }
        }
        sections.push(roomLines.join("\n"));
      }
      return {
        ok: true,
        command: "/status",
        text: sections.join("\n\n") || "Không có dữ liệu dự án.",
        data: { rooms: targetRooms.map((r) => ({ room: r, tasks: roomTasks(r.id) })) },
      };
    }

    return {
      ok: false,
      command: cmd,
      text: "Lệnh không hợp lệ. Hỗ trợ: /tasks, /tasks <Agent>, /task <KEY>, /blocked, /status",
    };
  }
}

