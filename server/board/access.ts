// Who may read and change what on the board. Reading is the project's own audience plus the existing
// conversation/bot visibility; a board row never widens access to a transcript.
import type { BoardAuditEntry, BoardCounts, BoardProject, BoardState, BoardTask, BoardVisibility } from "../../shared/board.ts";
import { viewerSees, type VisibleSet } from "../bot-visibility.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import type { BoardActor } from "./store.ts";

export interface BoardViewer {
  /** Owner/admin: creates projects and may change any board object. */
  admin: boolean;
  email?: string;
  visible: VisibleSet;
}

export interface BoardPermissions {
  projects: Record<string, boolean>;
  tasks: Record<string, boolean>;
  milestones: Record<string, boolean>;
}

export function actorFor(auth: RequestAuth): BoardActor {
  if (auth.kind === "loopback") return { label: "This computer" };
  const email = auth.session.email?.trim().toLowerCase();
  return { label: email || auth.session.id, ...(email ? { email } : {}) };
}

export function boardViewer(auth: RequestAuth, visible: VisibleSet): BoardViewer {
  const email = auth.kind === "session" ? auth.session.email?.trim().toLowerCase() : undefined;
  return { admin: ownerOrAdmin(auth), ...(email ? { email } : {}), visible };
}

function audience(value: BoardVisibility | undefined): BoardVisibility {
  return value ?? "admins";
}

export function projectVisible(project: BoardProject, viewer: BoardViewer): boolean {
  if (viewer.admin) return true;
  if (viewer.email && project.ownerEmail === viewer.email) return true;
  try {
    return viewerSees({ kind: "member", ...(viewer.email ? { email: viewer.email } : {}) }, audience(project.visibility));
  } catch {
    return false;
  }
}

export function projectEditable(project: BoardProject, viewer: BoardViewer): boolean {
  return viewer.admin || Boolean(viewer.email && project.ownerEmail === viewer.email);
}

export function taskEditable(task: BoardTask, project: BoardProject | undefined, viewer: BoardViewer): boolean {
  return Boolean(project && projectEditable(project, viewer)) || Boolean(viewer.email && task.ownerEmail === viewer.email);
}

/** A conversation is only visible when its own thread and bot are, never merely because a board row names it. */
export function conversationVisible(task: Pick<BoardTask, "threadId" | "botId">, viewer: BoardViewer): boolean {
  return viewer.visible.thread(task.threadId) && viewer.visible.bot(task.botId);
}

export function filterBoard(state: BoardState, viewer: BoardViewer): {
  state: BoardState;
  permissions: BoardPermissions;
  counts: BoardCounts;
} {
  const projects = state.projects.filter((project) => projectVisible(project, viewer));
  const projectIds = new Set(projects.map((project) => project.id));
  const subprojects = state.subprojects.filter((subproject) => projectIds.has(subproject.projectId));
  const milestones = state.milestones.filter((milestone) => projectIds.has(milestone.projectId));
  const tasks = state.tasks.filter((task) => {
    if (task.projectId !== undefined && !projectIds.has(task.projectId)) return false;
    return conversationVisible(task, viewer);
  });
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const permissions: BoardPermissions = {
    projects: Object.fromEntries(projects.map((project) => [project.id, projectEditable(project, viewer)])),
    tasks: Object.fromEntries(tasks.map((task) => [task.threadId, taskEditable(task, task.projectId ? projectsById.get(task.projectId) : undefined, viewer)])),
    milestones: Object.fromEntries(milestones.map((milestone) => [milestone.id, projectEditable(projectsById.get(milestone.projectId)!, viewer)])),
  };
  const taskIds = new Set(tasks.map((task) => task.threadId));
  const roots = tasks.filter((task) => !task.parentThreadId || !taskIds.has(task.parentThreadId));
  const counts: BoardCounts = {
    tasks: tasks.length,
    topLevel: roots.length,
    subtasks: tasks.length - roots.length,
    done: tasks.filter((task) => task.status === "done").length,
  };
  return {
    state: {
      version: state.version,
      projects,
      subprojects,
      milestones,
      tasks,
      updatedAt: state.updatedAt,
    },
    permissions,
    counts,
  };
}

export type BoardAudit = BoardAuditEntry;
