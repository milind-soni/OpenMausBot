import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { newId } from "./contracts.ts";

export const TASK_STATUSES = ["todo", "doing", "review", "done"] as const;
export const TASK_TYPES = ["feature", "bug", "task", "research", "documentation", "maintenance"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskType = (typeof TASK_TYPES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export type TaskActor =
  | { kind: "user" }
  | { kind: "bot"; botId: string; name: string }
  // legacy history only: changes applied by the removed Trello sync. Old
  // activity entries keep it so the trail never misattributes them to "You".
  | { kind: "sync"; source: string };

export interface TaskActivity {
  id: string;
  action: "created" | "updated" | "moved" | "claimed" | "delegated";
  actor: TaskActor;
  at: number;
  detail?: string;
}

export interface TaskRecord {
  id: string;
  /** Stable %mention slug, derived from the title at creation time and never
   * regenerated on edit — so an old %slug reference in chat history keeps
   * resolving to the same task even after a rename. */
  mention: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  type: TaskType;
  priority: TaskPriority;
  tags: string[];
  dueAt: number | null;
  projectId: string | null;
  assigneeBotId: string | null;
  position: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  createdBy: TaskActor;
  updatedBy: TaskActor;
  activity: TaskActivity[];
}

const MENTION_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** lowercase, non-alphanumeric runs -> "-", trimmed, capped; "task" if empty. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "task";
}

/** Slugify + auto-suffix ("-2", "-3", …) against mentions already in use. */
function uniqueMention(title: string, taken: Set<string>): string {
  const base = slugify(title);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface TaskFilters {
  text?: string;
  projectId?: string | null;
  assigneeBotId?: string | null;
  status?: TaskStatus;
  type?: TaskType;
  priority?: TaskPriority;
  tag?: string;
  overdue?: boolean;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  status?: TaskStatus;
  type?: TaskType;
  priority?: TaskPriority;
  tags?: string[];
  dueAt?: number | string | null;
  projectId?: string | null;
  assigneeBotId?: string | null;
  position?: number;
}

export type UpdateTaskInput = Partial<Omit<CreateTaskInput, "position">> & {
  position?: number;
};

export class TaskValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

export class TaskConflictError extends Error {
  readonly status = 409;
  latest: TaskRecord;

  constructor(message: string, latest: TaskRecord) {
    super(message);
    this.name = "TaskConflictError";
    this.latest = latest;
  }
}

export class TaskNotFoundError extends Error {
  readonly status = 404;

  constructor(message = "No such task.") {
    super(message);
    this.name = "TaskNotFoundError";
  }
}

const TASKS_FILE = "tasks.json";
const MAX_ACTIVITY = 200;

const isStatus = (value: unknown): value is TaskStatus => TASK_STATUSES.includes(value as TaskStatus);
const isType = (value: unknown): value is TaskType => TASK_TYPES.includes(value as TaskType);
const isPriority = (value: unknown): value is TaskPriority => TASK_PRIORITIES.includes(value as TaskPriority);

function cleanText(value: unknown, label: string, max: number, required = false): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new TaskValidationError(`${label} must be text.`);
  const cleaned = value.trim();
  if (required && !cleaned) throw new TaskValidationError(`${label} is required.`);
  if (cleaned.length > max) throw new TaskValidationError(`${label} must be ${max} characters or fewer.`);
  return cleaned;
}

function cleanOptionalId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new TaskValidationError(`${label} is invalid.`);
  }
  return value.trim();
}

function cleanCriteria(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30) {
    throw new TaskValidationError("Acceptance criteria must be a list of 30 items or fewer.");
  }
  return value.map((item) => cleanText(item, "Acceptance criterion", 500, true));
}

function cleanTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new TaskValidationError("Tags must be a list of 20 items or fewer.");
  const tags = value.map((tag) => cleanText(tag, "Tag", 40, true).toLowerCase());
  return [...new Set(tags)];
}

function cleanDueAt(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const timestamp = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new TaskValidationError("Due date is invalid.");
  return timestamp;
}

function cleanPosition(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new TaskValidationError("Task position is invalid.");
  }
  return value;
}

function isActor(value: unknown): value is TaskActor {
  if (!value || typeof value !== "object") return false;
  const actor = value as Record<string, unknown>;
  if (actor.kind === "user") return true;
  if (actor.kind === "bot") return typeof actor.botId === "string" && typeof actor.name === "string";
  if (actor.kind === "sync") return typeof actor.source === "string";
  return false;
}

function validateSavedTask(value: unknown): TaskRecord {
  if (!value || typeof value !== "object") throw new TaskValidationError("Saved task data is invalid. The file was left unchanged.");
  const task = value as Record<string, unknown>;
  const valid =
    typeof task.id === "string" &&
    (task.mention === undefined || (typeof task.mention === "string" && MENTION_PATTERN.test(task.mention))) &&
    typeof task.title === "string" && task.title.length > 0 &&
    typeof task.description === "string" &&
    Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.every((item) => typeof item === "string") &&
    isStatus(task.status) && isType(task.type) && isPriority(task.priority) &&
    Array.isArray(task.tags) && task.tags.every((tag) => typeof tag === "string") &&
    (task.dueAt === null || typeof task.dueAt === "number") &&
    (task.projectId === null || typeof task.projectId === "string") &&
    (task.assigneeBotId === null || typeof task.assigneeBotId === "string") &&
    typeof task.position === "number" && Number.isFinite(task.position) &&
    typeof task.revision === "number" && Number.isInteger(task.revision) && task.revision > 0 &&
    typeof task.createdAt === "number" && typeof task.updatedAt === "number" &&
    isActor(task.createdBy) && isActor(task.updatedBy) &&
    Array.isArray(task.activity) && task.activity.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const event = entry as Record<string, unknown>;
      return typeof event.id === "string" && typeof event.at === "number" && typeof event.action === "string" && isActor(event.actor);
    });
  if (!valid) throw new TaskValidationError("Saved task data is invalid. The file was left unchanged.");
  // saves from before Trello's removal carry card fields — drop them
  const { trelloCardId: _cardId, trelloCardUrl: _cardUrl, ...rest } = task;
  return {
    ...(rest as unknown as TaskRecord),
    // "" is a backfill marker for legacy saves predating `mention` — filled
    // in by reloadIfChanged() once the full task list is in hand (dedup
    // needs siblings), never persisted as an empty string.
    mention: (task.mention as string | undefined) ?? "",
  };
}

function actorLabel(actor: TaskActor): string {
  if (actor.kind === "user") return "You";
  if (actor.kind === "bot") return actor.name;
  return "Trello sync (removed)";
}

function activity(action: TaskActivity["action"], actor: TaskActor, detail?: string): TaskActivity {
  return { id: newId(), action, actor, at: Date.now(), ...(detail ? { detail } : {}) };
}

function compareTasks(a: TaskRecord, b: TaskRecord): number {
  return a.status === b.status ? a.position - b.position || b.updatedAt - a.updatedAt : TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status);
}

export function filterTasks(tasks: TaskRecord[], filters: TaskFilters, now = Date.now()): TaskRecord[] {
  const needle = filters.text?.trim().toLowerCase();
  const tag = filters.tag?.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filters.projectId !== undefined && task.projectId !== filters.projectId) return false;
    if (filters.assigneeBotId !== undefined && task.assigneeBotId !== filters.assigneeBotId) return false;
    if (filters.status && task.status !== filters.status) return false;
    if (filters.type && task.type !== filters.type) return false;
    if (filters.priority && task.priority !== filters.priority) return false;
    if (tag && !task.tags.includes(tag)) return false;
    if (filters.overdue !== undefined) {
      const overdue = task.dueAt !== null && task.dueAt < now && task.status !== "done";
      if (overdue !== filters.overdue) return false;
    }
    if (needle) {
      const haystack = [task.title, task.description, ...task.acceptanceCriteria, ...task.tags].join(" ").toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  }).sort(compareTasks);
}

/** Reverse-match: %mention text -> known tasks, mirroring server/projects.ts's mentionedProjects. */
export function mentionedTasks(text: string, tasks: TaskRecord[]): TaskRecord[] {
  const byMention = new Map(tasks.map((task) => [task.mention, task]));
  const seen = new Set<string>();
  const referenced: TaskRecord[] = [];
  for (const match of text.matchAll(/%[a-z0-9][a-z0-9._-]*/gi)) {
    const start = match.index;
    if (start > 0 && /[a-z0-9_#@%]/i.test(text[start - 1])) continue;
    const handle = match[0].replace(/[._-]+$/, "").slice(1).toLowerCase();
    const task = byMention.get(handle);
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    referenced.push(task);
  }
  return referenced;
}

export interface TaskMentionContext {
  tasks: TaskRecord[];
  system: string;
}

/** Sources are ordered from highest to lowest priority. The first source
 * containing known task references owns the turn's task context. */
export function resolveTaskContext(sources: string[], tasks: TaskRecord[]): TaskMentionContext {
  let referenced: TaskRecord[] = [];
  for (const source of sources) {
    referenced = mentionedTasks(source, tasks);
    if (referenced.length > 0) break;
  }
  if (referenced.length === 0) return { tasks: [], system: "" };

  const lines = referenced.map((task) => {
    const description = task.description.length > 500 ? `${task.description.slice(0, 500)}…` : task.description;
    return [
      `- %${task.mention} — "${task.title}" (status: ${task.status}, priority: ${task.priority})`,
      description ? `  ${description}` : null,
    ].filter(Boolean).join("\n");
  });
  return {
    tasks: referenced,
    system: [
      "Trusted task references from the user's task board:",
      ...lines,
      "Use this as ground truth for the referenced tasks; do not infer their status or content from other text.",
    ].join("\n"),
  };
}

export class TaskStore {
  readonly filePath: string;
  tasks: TaskRecord[];
  private fileStamp: string | null = null;

  constructor(dataDir: string) {
    if (!dataDir) throw new TaskValidationError("Task data directory is required.");
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, TASKS_FILE);
    this.tasks = [];
    this.reloadIfChanged(true);
  }

  private diskStamp(): string | null {
    try {
      const stat = statSync(this.filePath);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
  }

  private reloadIfChanged(force = false): boolean {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = this.diskStamp();
      if (!force && before === this.fileStamp) return false;
      if (before === null) {
        this.tasks = [];
        this.fileStamp = null;
        return true;
      }
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      const after = this.diskStamp();
      if (before !== after) continue;
      if (!Array.isArray(parsed)) throw new TaskValidationError("Saved task data is invalid. The file was left unchanged.");
      const tasks = parsed.map(validateSavedTask).sort(compareTasks);
      const taken = new Set(tasks.map((task) => task.mention).filter(Boolean));
      let backfilled = false;
      for (const task of tasks) {
        if (task.mention) continue;
        task.mention = uniqueMention(task.title, taken);
        taken.add(task.mention);
        backfilled = true;
      }
      this.tasks = tasks;
      this.fileStamp = after;
      if (backfilled) this.save();
      return true;
    }
    throw new TaskValidationError("Task data changed while it was being loaded. Try again.");
  }

  private save(): void {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.tasks, null, 2), { mode: 0o600 });
      renameSync(temporary, this.filePath);
      this.fileStamp = this.diskStamp();
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  list(filters: TaskFilters = {}): TaskRecord[] {
    this.reloadIfChanged();
    return filterTasks(this.tasks, filters);
  }

  get(id: string): TaskRecord | undefined {
    this.reloadIfChanged();
    return this.tasks.find((task) => task.id === id);
  }

  private nextPosition(status: TaskStatus): number {
    return Math.max(0, ...this.tasks.filter((task) => task.status === status).map((task) => task.position)) + 1024;
  }

  create(input: CreateTaskInput, actor: TaskActor): TaskRecord {
    this.reloadIfChanged();
    const status = input.status ?? "todo";
    const type = input.type ?? "feature";
    const priority = input.priority ?? "normal";
    if (!isStatus(status)) throw new TaskValidationError("Task status is invalid.");
    if (!isType(type)) throw new TaskValidationError("Task type is invalid.");
    if (!isPriority(priority)) throw new TaskValidationError("Task priority is invalid.");
    const now = Date.now();
    const title = cleanText(input.title, "Title", 200, true);
    const task: TaskRecord = {
      id: newId(),
      mention: uniqueMention(title, new Set(this.tasks.map((t) => t.mention))),
      title,
      description: cleanText(input.description, "Description", 20_000),
      acceptanceCriteria: cleanCriteria(input.acceptanceCriteria),
      status,
      type,
      priority,
      tags: cleanTags(input.tags),
      dueAt: cleanDueAt(input.dueAt),
      projectId: cleanOptionalId(input.projectId, "Project"),
      assigneeBotId: cleanOptionalId(input.assigneeBotId, "Assignee"),
      position: input.position === undefined ? this.nextPosition(status) : cleanPosition(input.position),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
      activity: [activity("created", actor)],
    };
    this.tasks.push(task);
    this.tasks.sort(compareTasks);
    this.save();
    return task;
  }

  private current(id: string, expectedRevision: number): TaskRecord {
    const task = this.get(id);
    if (!task) throw new TaskNotFoundError();
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new TaskValidationError("A valid task revision is required.");
    if (task.revision !== expectedRevision) throw new TaskConflictError("This task changed since it was loaded.", task);
    return task;
  }

  update(id: string, expectedRevision: number, patch: UpdateTaskInput, actor: TaskActor): TaskRecord {
    const current = this.current(id, expectedRevision);
    const next: TaskRecord = { ...current };
    const changes: string[] = [];
    if (patch.title !== undefined) { next.title = cleanText(patch.title, "Title", 200, true); changes.push("title"); }
    if (patch.description !== undefined) { next.description = cleanText(patch.description, "Description", 20_000); changes.push("description"); }
    if (patch.acceptanceCriteria !== undefined) { next.acceptanceCriteria = cleanCriteria(patch.acceptanceCriteria); changes.push("acceptance criteria"); }
    if (patch.type !== undefined) {
      if (!isType(patch.type)) throw new TaskValidationError("Task type is invalid.");
      next.type = patch.type; changes.push("type");
    }
    if (patch.priority !== undefined) {
      if (!isPriority(patch.priority)) throw new TaskValidationError("Task priority is invalid.");
      next.priority = patch.priority; changes.push("priority");
    }
    if (patch.tags !== undefined) { next.tags = cleanTags(patch.tags); changes.push("tags"); }
    if (patch.dueAt !== undefined) { next.dueAt = cleanDueAt(patch.dueAt); changes.push("due date"); }
    if (patch.projectId !== undefined) { next.projectId = cleanOptionalId(patch.projectId, "Project"); changes.push("project"); }
    if (patch.assigneeBotId !== undefined) { next.assigneeBotId = cleanOptionalId(patch.assigneeBotId, "Assignee"); changes.push("assignee"); }
    if (patch.position !== undefined) { next.position = cleanPosition(patch.position); changes.push("position"); }
    let action: TaskActivity["action"] = "updated";
    if (patch.status !== undefined) {
      if (!isStatus(patch.status)) throw new TaskValidationError("Task status is invalid.");
      if (patch.status !== current.status) {
        next.status = patch.status;
        if (patch.position === undefined) next.position = this.nextPosition(patch.status);
        changes.push(`${current.status} → ${patch.status}`);
        action = "moved";
      }
    }
    if (!changes.length) return current;
    next.revision += 1;
    next.updatedAt = Date.now();
    next.updatedBy = actor;
    next.activity = [...current.activity, activity(action, actor, changes.join(", "))].slice(-MAX_ACTIVITY);
    this.tasks = this.tasks.map((task) => task.id === id ? next : task).sort(compareTasks);
    this.save();
    return next;
  }

  claim(id: string, expectedRevision: number, actor: Extract<TaskActor, { kind: "bot" }>): TaskRecord {
    const current = this.current(id, expectedRevision);
    if (current.status === "done") throw new TaskConflictError("Completed tasks cannot be claimed.", current);
    if (current.assigneeBotId && current.assigneeBotId !== actor.botId) {
      throw new TaskConflictError("This task is already assigned to another agent.", current);
    }
    if (current.assigneeBotId === actor.botId && current.status === "doing") return current;
    const next: TaskRecord = {
      ...current,
      assigneeBotId: actor.botId,
      status: "doing",
      position: current.status === "doing" ? current.position : this.nextPosition("doing"),
      revision: current.revision + 1,
      updatedAt: Date.now(),
      updatedBy: actor,
      activity: [...current.activity, activity("claimed", actor, `${actorLabel(actor)} claimed this task`)].slice(-MAX_ACTIVITY),
    };
    this.tasks = this.tasks.map((task) => task.id === id ? next : task).sort(compareTasks);
    this.save();
    return next;
  }

  delegate(id: string, expectedRevision: number, targetBotId: string, targetName: string, actor: TaskActor): TaskRecord {
    const current = this.current(id, expectedRevision);
    if (current.status === "done") throw new TaskConflictError("Completed tasks cannot be delegated.", current);
    const assigneeBotId = cleanOptionalId(targetBotId, "Assignee");
    if (!assigneeBotId) throw new TaskValidationError("Assignee is required.");
    if (current.assigneeBotId === assigneeBotId) return current;
    const next: TaskRecord = {
      ...current,
      assigneeBotId,
      revision: current.revision + 1,
      updatedAt: Date.now(),
      updatedBy: actor,
      activity: [...current.activity, activity("delegated", actor, `Assigned to ${cleanText(targetName, "Assignee name", 200, true)}`)].slice(-MAX_ACTIVITY),
    };
    this.tasks = this.tasks.map((task) => task.id === id ? next : task).sort(compareTasks);
    this.save();
    return next;
  }

  delete(id: string, expectedRevision: number): TaskRecord {
    const current = this.current(id, expectedRevision);
    this.tasks = this.tasks.filter((task) => task.id !== id);
    this.save();
    return current;
  }
}
