// The project board's reading layer: a board snapshot is flat (projects, subprojects, milestones,
// tasks by id), while the page shows one tree. Everything here is pure so the counts, the filters
// and the "waiting to be classified" list can be tested without a server or a browser.
import type { BoardMilestone, BoardPhase, BoardSnapshot, BoardSubproject, BoardTask, BoardTaskStatus } from "../../shared/board";
import type { LocaleKey } from "@/locales";

export const BOARD_PHASE_ORDER: readonly BoardPhase[] = [
  "discovery", "design", "build", "test", "release_ready", "live_unverified", "done",
];

export const TASK_STATUS_ORDER: readonly BoardTaskStatus[] = ["todo", "in_progress", "review", "done"];

export const PHASE_LABEL: Readonly<Record<BoardPhase, LocaleKey>> = {
  discovery: "board.phase.discovery",
  design: "board.phase.design",
  build: "board.phase.build",
  test: "board.phase.test",
  release_ready: "board.phase.releaseReady",
  live_unverified: "board.phase.liveUnverified",
  done: "board.phase.done",
};

export const TASK_STATUS_LABEL: Readonly<Record<BoardTaskStatus, LocaleKey>> = {
  todo: "board.task.todo",
  in_progress: "board.task.inProgress",
  review: "board.task.review",
  done: "board.task.done",
};

export const MILESTONE_LABEL: Readonly<Record<BoardMilestone["status"], LocaleKey>> = {
  planned: "board.milestone.planned",
  in_progress: "board.milestone.inProgress",
  accepted: "board.milestone.accepted",
  rejected: "board.milestone.rejected",
};

type LocaleSource = Readonly<Record<string, string>>;

/** The label a phase or status shows; a board that speaks a newer phase than this page reads as is shown as it is, not hid. */
export function phaseLabel(phase: string, locale: LocaleSource): string {
  const key = PHASE_LABEL[phase as BoardPhase];
  return key && locale[key] ? locale[key]! : phase;
}

export function statusLabel(status: string, locale: LocaleSource): string {
  const key = TASK_STATUS_LABEL[status as BoardTaskStatus];
  return key && locale[key] ? locale[key]! : status;
}

export function milestoneLabel(status: string, locale: LocaleSource): string {
  const key = MILESTONE_LABEL[status as BoardMilestone["status"]];
  return key && locale[key] ? locale[key]! : status;
}

export interface BoardSubprojectNode {
  subproject: BoardSubproject;
  milestones: BoardMilestone[];
  /** Rows at this level; their children render under them. */
  tasks: BoardTask[];
  /** Every task in the subproject, children included, for filtering. */
  every: BoardTask[];
}

export interface BoardProjectNode {
  project: BoardSnapshot["projects"][number];
  subprojects: BoardSubprojectNode[];
  /** Milestones set on the project itself, not on one of its subprojects. */
  milestones: BoardMilestone[];
  tasks: BoardTask[];
  every: BoardTask[];
}

/** Tasks that point at a project this account can see but at no subproject, or at an unknown one. */
export interface BoardLoose {
  subproject: BoardSubproject | undefined;
  tasks: BoardTask[];
  milestones: BoardMilestone[];
}

export interface BoardTree {
  projects: BoardProjectNode[];
  /** Classified tasks whose project or subproject is missing: shown, never silently dropped. */
  loose: BoardTask[];
  unclassified: BoardTask[];
}

export function isTopLevel(task: BoardTask, byThread: ReadonlyMap<string, BoardTask>): boolean {
  return !task.parentThreadId || !byThread.has(task.parentThreadId);
}

/** Tasks with no parent inside this list: what a list shows at its own level, children render under them. */
export function rootsOf(tasks: readonly BoardTask[]): BoardTask[] {
  const ids = new Set(tasks.map((task) => task.threadId));
  return tasks.filter((task) => !task.parentThreadId || !ids.has(task.parentThreadId));
}

export function tasksByThread(tasks: readonly BoardTask[]): Map<string, BoardTask> {
  return new Map(tasks.map((task) => [task.threadId, task]));
}

/** Children in a stable order: newest updated first, so the working task leads. */
export function childTasks(parent: BoardTask, tasks: readonly BoardTask[]): BoardTask[] {
  return tasks
    .filter((task) => task.parentThreadId === parent.threadId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function boardTree(board: Pick<BoardSnapshot, "projects" | "subprojects" | "milestones" | "tasks">): BoardTree {
  const unclassified = board.tasks
    .filter((task) => !task.projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const loose: BoardTask[] = [];
  const projects = [...board.projects]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((project): BoardProjectNode => {
      const ownTasks = board.tasks
        .filter((task) => task.projectId === project.id)
        .filter((task) => {
          if (!task.subprojectId) return true;
          return board.subprojects.some((subproject) => subproject.id === task.subprojectId && subproject.projectId === project.id);
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      // A task whose subproject belongs elsewhere is a board inconsistency; list it rather than hide it.
      for (const task of board.tasks) {
        if (task.projectId === project.id && task.subprojectId && !ownTasks.includes(task)) loose.push(task);
      }
      const subprojects = board.subprojects
        .filter((subproject) => subproject.projectId === project.id)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((subproject): BoardSubprojectNode => {
          const every = ownTasks.filter((task) => task.subprojectId === subproject.id);
          return {
            subproject,
            milestones: board.milestones
              .filter((milestone) => milestone.subprojectId === subproject.id)
              .sort(byMilestone),
            tasks: rootsOf(every),
            every,
          };
        });
      return {
        project,
        subprojects,
        milestones: board.milestones
          .filter((milestone) => milestone.projectId === project.id && !milestone.subprojectId)
          .sort(byMilestone),
        tasks: rootsOf(ownTasks.filter((task) => !task.subprojectId)),
        every: ownTasks.filter((task) => !task.subprojectId),
      };
    });
  for (const task of board.tasks) {
    if (task.projectId && !board.projects.some((project) => project.id === task.projectId)) loose.push(task);
  }
  return { projects, loose, unclassified };
}

function byMilestone(a: BoardMilestone, b: BoardMilestone): number {
  const order: Record<BoardMilestone["status"], number> = { accepted: 0, rejected: 1, in_progress: 2, planned: 3 };
  const due = (milestone: BoardMilestone) => milestone.dueAt ?? Number.MAX_SAFE_INTEGER;
  return order[a.status] - order[b.status] || due(a) - due(b) || a.title.localeCompare(b.title);
}

export interface TaskCounts {
  /** Top-level tasks: one per piece of work, so a parent and its children never count twice. */
  main: number;
  mainDone: number;
  subtasks: number;
  subtasksAccepted: number;
}

export function taskCounts(tasks: readonly BoardTask[]): TaskCounts {
  const byThread = tasksByThread(tasks);
  const roots = tasks.filter((task) => isTopLevel(task, byThread));
  const subtasks = tasks.filter((task) => !isTopLevel(task, byThread));
  return {
    main: roots.length,
    mainDone: roots.filter((task) => task.status === "done").length,
    subtasks: subtasks.length,
    subtasksAccepted: subtasks.filter((task) => task.status === "done").length,
  };
}

/** A main task's own progress through its children; the main task's status stays its own. */
export function subtaskProgress(task: BoardTask, tasks: readonly BoardTask[]): { done: number; total: number } {
  const children = childTasks(task, tasks);
  return { done: children.filter((child) => child.status === "done").length, total: children.length };
}

export function milestoneCounts(milestones: readonly BoardMilestone[]): { accepted: number; total: number } {
  return {
    accepted: milestones.filter((milestone) => milestone.status === "accepted").length,
    total: milestones.length,
  };
}

export interface PhaseCount {
  phase: BoardPhase;
  count: number;
}

/** Task phases in the seven-phase order, counting top-level tasks only. */
export function phaseDistribution(tasks: readonly BoardTask[]): PhaseCount[] {
  const byThread = tasksByThread(tasks);
  const counts = new Map<BoardPhase, number>();
  for (const task of tasks) {
    if (!isTopLevel(task, byThread)) continue;
    counts.set(task.phase, (counts.get(task.phase) ?? 0) + 1);
  }
  return BOARD_PHASE_ORDER.filter((phase) => counts.has(phase)).map((phase) => ({ phase, count: counts.get(phase)! }));
}

export type BoardFlag = "review" | "blocked" | "paused";

export interface BoardFilter {
  query: string;
  owner: string;
  status: "" | BoardTaskStatus;
  flag: "" | BoardFlag;
}

export const EMPTY_FILTER: BoardFilter = { query: "", owner: "", status: "", flag: "" };

export function filterIsEmpty(filter: BoardFilter): boolean {
  return !filter.query.trim() && !filter.owner && !filter.status && !filter.flag;
}

export interface TaskMatchContext {
  /** The conversation's title, joined from the bot snapshot; a board row never stores it. */
  title: string;
  botName: string;
  projectName: string;
  subprojectName: string;
}

function text(value: string | undefined): string {
  return (value ?? "").toLocaleLowerCase();
}

export function taskFits(task: BoardTask, filter: BoardFilter): boolean {
  if (filter.status && task.status !== filter.status) return false;
  if (filter.owner && text(task.owner) !== text(filter.owner)) return false;
  if (filter.flag === "review" && task.status !== "review") return false;
  if (filter.flag === "blocked" && !task.blocked) return false;
  if (filter.flag === "paused" && !task.paused) return false;
  return true;
}

function taskTextMatches(task: BoardTask, filter: BoardFilter, context: TaskMatchContext): boolean {
  const query = text(filter.query.trim());
  if (!query) return true;
  return [context.title, task.owner, task.acceptance, context.botName, context.projectName, context.subprojectName, task.threadId]
    .some((value) => text(value).includes(query));
}

export function taskMatches(task: BoardTask, filter: BoardFilter, context: TaskMatchContext): boolean {
  return taskFits(task, filter) && taskTextMatches(task, filter, context);
}

export interface FilteredBoard {
  projects: BoardProjectNode[];
  loose: BoardTask[];
  unclassified: BoardTask[];
  /** The tasks to draw, ancestors included; a row hides children outside this set. */
  visible: Set<string>;
  /** How many tasks the filter kept, for "no results" copy. */
  shown: number;
}

/** Keeps the tasks that match, their ancestors, and any project whose own name matches (all of its tasks). */
export function filterBoard(tree: BoardTree, filter: BoardFilter, context: (task: BoardTask) => TaskMatchContext): FilteredBoard {
  if (filterIsEmpty(filter)) {
    const shown = tree.projects.reduce((sum, project) => sum + project.tasks.length + project.subprojects.reduce((inner, subproject) => inner + subproject.tasks.length, 0), 0) + tree.loose.length;
    return { projects: tree.projects, loose: tree.loose, unclassified: tree.unclassified, visible: new Set<string>(), shown };
  }
  const query = text(filter.query.trim());
  let shown = 0;
  const visible = new Set<string>();
  const keep = (tasks: BoardTask[], projectName: string, subprojectName: string, named: boolean): Set<string> => {
    const byId = new Map(tasks.map((task) => [task.threadId, task]));
    const matched = new Set<string>();
    for (const task of tasks) {
      if (taskFits(task, filter) && (named || taskTextMatches(task, filter, { ...context(task), projectName, subprojectName }))) matched.add(task.threadId);
    }
    shown += matched.size;
    // A matched child keeps its parent rows, so the branch it sits in stays readable.
    const kept = new Set(matched);
    for (const id of matched) {
      let parent = byId.get(id)?.parentThreadId;
      for (let depth = 0; parent && depth < 100; depth += 1) {
        kept.add(parent);
        parent = byId.get(parent)?.parentThreadId;
      }
    }
    for (const id of kept) visible.add(id);
    return kept;
  };
  const projects = tree.projects.flatMap((project): BoardProjectNode[] => {
    const projectNamed = Boolean(query) && text(project.project.name).includes(query);
    const subprojects = project.subprojects.flatMap((subproject): BoardSubprojectNode[] => {
      const named = projectNamed || (Boolean(query) && text(subproject.subproject.name).includes(query));
      const kept = keep(subproject.every, project.project.name, subproject.subproject.name, named);
      const tasks = subproject.tasks.filter((task) => kept.has(task.threadId));
      if (!kept.size && !named) return [];
      return [{ ...subproject, tasks }];
    });
    const keptProject = keep(project.every, project.project.name, "", projectNamed);
    const tasks = project.tasks.filter((task) => keptProject.has(task.threadId));
    if (!subprojects.length && !keptProject.size && !projectNamed) return [];
    // A project with no kept task still shows its milestones when the project itself matched.
    return [{ project: project.project, subprojects, milestones: projectNamed ? project.milestones : [], tasks, every: [] }];
  });
  const loose = tree.loose.filter((task) => taskMatches(task, filter, context(task)));
  for (const task of loose) visible.add(task.threadId);
  shown += loose.length;
  return { projects, loose, unclassified: tree.unclassified, visible, shown };
}

export interface ConversationRef {
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  updatedAt: number;
}

export interface BotConversations {
  id: string;
  name: string;
  hidden?: boolean;
  threadId?: string;
  tasks?: ReadonlyArray<{ threadId: string; title?: string; updatedAt?: number }>;
}

/** Classified conversation ids, to subtract from the bot snapshot. */
export function classifiedThreadIds(board: Pick<BoardSnapshot, "tasks">): Set<string> {
  return new Set(board.tasks.map((task) => task.threadId));
}

/** Every conversation the person can see that has no board row yet, newest first. */
export function unclassifiedConversations(bots: readonly BotConversations[], board: Pick<BoardSnapshot, "tasks">): ConversationRef[] {
  const classified = classifiedThreadIds(board);
  const found: ConversationRef[] = [];
  for (const bot of bots) {
    if (bot.hidden) continue;
    for (const task of bot.tasks ?? []) {
      if (classified.has(task.threadId)) continue;
      found.push({
        botId: bot.id,
        botName: bot.name,
        threadId: task.threadId,
        title: task.title?.trim() || task.threadId,
        updatedAt: task.updatedAt ?? 0,
      });
    }
  }
  return found.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Who can belong on a task: the bot names, so a classification can name the bot that does the work. */
export function ownerSuggestions(bots: readonly { name: string }[], tasks: readonly BoardTask[]): string[] {
  const names = new Set<string>();
  for (const task of tasks) if (task.owner?.trim()) names.add(task.owner.trim());
  for (const bot of bots) if (bot.name.trim()) names.add(bot.name.trim());
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function boardTaskTitle(task: BoardTask, bots: readonly BotConversations[], fallback: string): string {
  for (const bot of bots) {
    if (bot.id !== task.botId) continue;
    const found = bot.tasks?.find((candidate) => candidate.threadId === task.threadId);
    if (found?.title?.trim()) return found.title;
  }
  return fallback;
}

export function botNameOf(task: BoardTask, bots: readonly { id: string; name: string }[]): string | undefined {
  return bots.find((bot) => bot.id === task.botId)?.name;
}

/** Subprojects that hold this task, for the conversation chip and the board page's picker. */
export function projectOfTask(board: Pick<BoardSnapshot, "projects" | "subprojects">, task: BoardTask | undefined): {
  projectName: string; subprojectName?: string;
} | null {
  if (!task?.projectId) return null;
  const project = board.projects.find((candidate) => candidate.id === task.projectId);
  if (!project) return null;
  const subproject = task.subprojectId ? board.subprojects.find((candidate) => candidate.id === task.subprojectId) : undefined;
  return { projectName: project.name, ...(subproject ? { subprojectName: subproject.name } : {}) };
}

export const BOARD_PHASE_CLASS: Readonly<Record<BoardPhase, string>> = {
  discovery: "bg-raised text-ink-secondary",
  design: "bg-accent/12 text-accent-text",
  build: "bg-accent/12 text-accent-text",
  test: "bg-warning/15 text-warning-ink",
  release_ready: "bg-warning/15 text-warning-ink",
  live_unverified: "bg-success/15 text-success-ink",
  done: "bg-success/15 text-success-ink",
};

export const TASK_STATUS_CLASS: Readonly<Record<BoardTaskStatus, string>> = {
  todo: "bg-raised text-ink-secondary",
  in_progress: "bg-accent/12 text-accent-text",
  review: "bg-warning/15 text-warning-ink",
  done: "bg-success/15 text-success-ink",
};

export const MILESTONE_CLASS: Readonly<Record<BoardMilestone["status"], string>> = {
  planned: "bg-raised text-ink-secondary",
  in_progress: "bg-accent/12 text-accent-text",
  accepted: "bg-success/15 text-success-ink",
  rejected: "bg-danger/12 text-danger",
};
