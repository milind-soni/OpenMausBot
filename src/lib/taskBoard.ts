export const TASK_STATUSES = ["todo", "doing", "review", "done"] as const;
export const TASK_TYPES = ["feature", "bug", "task", "research", "documentation", "maintenance"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskType = (typeof TASK_TYPES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskActor = { kind: "user" } | { kind: "bot"; botId: string; name: string } | { kind: "sync"; source: "trello" };

export interface TaskActivity {
  id: string;
  action: "created" | "updated" | "moved" | "claimed" | "delegated";
  actor: TaskActor;
  at: number;
  detail?: string;
}

export interface TaskProject {
  id: string;
  name: string;
  mention: string;
  available: boolean;
}

export interface TaskAssignee {
  id: string;
  name: string;
  available: boolean;
}

export interface TaskRecord {
  id: string;
  /** Stable %mention slug, e.g. "fix-qt6-styling". */
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
  project: TaskProject | null;
  assignee: TaskAssignee | null;
  trelloCardId: string | null;
  trelloCardUrl: string | null;
}

export interface TaskFilters {
  text: string;
  projectId: string;
  assigneeBotId: string;
  status: string;
  type: string;
  priority: string;
  tag: string;
  overdue: boolean;
}

export const EMPTY_TASK_FILTERS: TaskFilters = {
  text: "",
  projectId: "",
  assigneeBotId: "",
  status: "",
  type: "",
  priority: "",
  tag: "",
  overdue: false,
};

export function filterBoardTasks(tasks: TaskRecord[], filters: TaskFilters, now = Date.now()): TaskRecord[] {
  const needles = filters.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const tag = filters.tag.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filters.projectId && (filters.projectId === "none" ? task.projectId !== null : task.projectId !== filters.projectId)) return false;
    if (filters.assigneeBotId && (filters.assigneeBotId === "unassigned" ? task.assigneeBotId !== null : task.assigneeBotId !== filters.assigneeBotId)) return false;
    if (filters.status && task.status !== filters.status) return false;
    if (filters.type && task.type !== filters.type) return false;
    if (filters.priority && task.priority !== filters.priority) return false;
    if (tag && !task.tags.includes(tag)) return false;
    if (filters.overdue && !(task.dueAt !== null && task.dueAt < now && task.status !== "done")) return false;
    if (needles.length) {
      const haystack = [
        task.title,
        task.description,
        task.project?.name ?? "",
        task.project?.mention ?? "",
        task.assignee?.name ?? "",
        ...task.acceptanceCriteria,
        ...task.tags,
      ].join(" ").toLowerCase();
      if (!needles.every((needle) => haystack.includes(needle))) return false;
    }
    return true;
  }).sort((a, b) => a.position - b.position || b.updatedAt - a.updatedAt);
}

export function positionForDrop(
  tasks: TaskRecord[],
  status: TaskStatus,
  movingId: string,
  beforeId: string | null,
): number {
  const column = tasks
    .filter((task) => task.status === status && task.id !== movingId)
    .sort((a, b) => a.position - b.position);
  if (!beforeId) return (column.at(-1)?.position ?? 0) + 1024;
  const index = column.findIndex((task) => task.id === beforeId);
  if (index < 0) return (column.at(-1)?.position ?? 0) + 1024;
  const before = column[index].position;
  const previous = column[index - 1]?.position;
  return previous === undefined ? before - 1024 : previous + (before - previous) / 2;
}

export function activeTaskFilterCount(filters: TaskFilters): number {
  return Object.entries(filters).filter(([, value]) => typeof value === "boolean" ? value : Boolean(value)).length;
}

export function secondaryTaskFilterCount(filters: TaskFilters): number {
  let count = 0;
  if (filters.type) count += 1;
  if (filters.priority) count += 1;
  if (filters.tag.trim()) count += 1;
  if (filters.overdue) count += 1;
  return count;
}

export interface TaskStarterPreset {
  id: string;
  label: string;
  title: string;
  description: string;
  criteria: string;
  type: TaskType;
  priority: TaskPriority;
}

export const TASK_STARTER_PRESETS: TaskStarterPreset[] = [
  {
    id: "roadmap",
    label: "Plan project roadmap",
    title: "Outline milestones and priorities for the next release",
    description: "Break down our upcoming goals into clear, actionable tasks for the team.",
    criteria: "Milestones are listed in order\nEach milestone has an owner",
    type: "feature",
    priority: "high",
  },
  {
    id: "research",
    label: "Research a topic",
    title: "Gather key findings and summarize options",
    description: "Compare approaches, note trade-offs, and recommend a clear next step.",
    criteria: "Key sources are linked\nSummary includes a recommendation",
    type: "research",
    priority: "normal",
  },
  {
    id: "docs",
    label: "Draft a guide or doc",
    title: "Write a plain-language guide for new readers",
    description: "Explain how the workflow works with clear examples and zero jargon.",
    criteria: "Draft is reviewed for clarity\nExamples are up to date",
    type: "documentation",
    priority: "normal",
  },
];
