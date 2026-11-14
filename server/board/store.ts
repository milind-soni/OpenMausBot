// The board's store: one workspace-wide board.json, written whole. Bots' `projects` are folders and stay
// separate; a board task only points at an existing conversation by botId + threadId.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  BOARD_MILESTONE_STATUSES, BOARD_PHASES, BOARD_TASK_STATUSES, BOARD_VERDICTS,
  type BoardBroadcast, type BoardMilestone, type BoardProject, type BoardSnapshot, type BoardState,
  type BoardSubproject, type BoardTask, type BoardTaskVerdictRecord,
} from "../../shared/board.ts";
import { writeFileAtomic } from "../atomic.ts";
import { newId } from "../contracts.ts";

export const BOARD_FILE = "board.json";

export type BoardErrorCode = "BOARD_INVALID" | "BOARD_FORBIDDEN" | "BOARD_VERSION_CONFLICT" | "BOARD_NEEDS_EVIDENCE";

export class BoardError extends Error {
  readonly code: BoardErrorCode;
  constructor(code: BoardErrorCode, message: string) {
    super(message);
    this.name = "BoardError";
    this.code = code;
  }
}

export const boardErrorStatus: Readonly<Record<BoardErrorCode, number>> = {
  BOARD_INVALID: 400,
  BOARD_FORBIDDEN: 403,
  BOARD_VERSION_CONFLICT: 409,
  BOARD_NEEDS_EVIDENCE: 422,
};

const NAME_MAX = 120;
const DESCRIPTION_MAX = 2_000;
const TITLE_MAX = 200;
const OWNER_MAX = 80;
const ACCEPTANCE_MAX = 4_000;
const EVIDENCE_MAX = 4_000;
const VERDICT_MAX = 2_000;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

const nowIso = (now: () => Date) => now().toISOString();

function emptyBoard(): BoardState {
  return { version: 0, projects: [], subprojects: [], milestones: [], tasks: [], updatedAt: new Date(0).toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function cleanText(value: unknown, field: string, max: number, required: true): string;
function cleanText(value: unknown, field: string, max: number, required?: false): string | undefined;
function cleanText(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new BoardError("BOARD_INVALID", `${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new BoardError("BOARD_INVALID", `${field} must be text`);
  const text = value.trim();
  if (!text) {
    if (required) throw new BoardError("BOARD_INVALID", `${field} cannot be empty`);
    return undefined;
  }
  if (text.length > max) throw new BoardError("BOARD_INVALID", `${field} is longer than ${max} characters`);
  return text;
}

function cleanId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new BoardError("BOARD_INVALID", `${field} is not a valid id`);
  return value;
}

function cleanVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new BoardError("BOARD_INVALID", "version must be a non-negative whole number");
  return value as number;
}

function cleanTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new BoardError("BOARD_INVALID", `${field} must be an epoch millisecond timestamp`);
  return Math.trunc(value);
}

function cleanBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new BoardError("BOARD_INVALID", `${field} must be true or false`);
  return value;
}

function normalizeProject(value: unknown): BoardProject | null {
  if (!isRecord(value) || typeof value.id !== "string" || !ID.test(value.id) || typeof value.name !== "string" || !value.name.trim()) return null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  return {
    id: value.id,
    name: value.name.trim().slice(0, NAME_MAX),
    ...(typeof value.description === "string" && value.description.trim() ? { description: value.description.trim().slice(0, DESCRIPTION_MAX) } : {}),
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
  };
}

function normalizeSubproject(value: unknown): BoardSubproject | null {
  if (!isRecord(value) || typeof value.id !== "string" || !ID.test(value.id) || typeof value.projectId !== "string" ||
    typeof value.name !== "string" || !value.name.trim()) return null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  return {
    id: value.id,
    projectId: value.projectId,
    name: value.name.trim().slice(0, NAME_MAX),
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
  };
}

function normalizeMilestone(value: unknown): BoardMilestone | null {
  if (!isRecord(value) || typeof value.id !== "string" || !ID.test(value.id) || typeof value.projectId !== "string" ||
    typeof value.title !== "string" || !value.title.trim() || !oneOf(value.status, BOARD_MILESTONE_STATUSES)) return null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  return {
    id: value.id,
    projectId: value.projectId,
    ...(typeof value.subprojectId === "string" ? { subprojectId: value.subprojectId } : {}),
    title: value.title.trim().slice(0, TITLE_MAX),
    status: value.status,
    ...(typeof value.verdict === "string" && value.verdict.trim() ? { verdict: value.verdict.trim().slice(0, VERDICT_MAX) } : {}),
    ...(typeof value.evidence === "string" && value.evidence.trim() ? { evidence: value.evidence.trim().slice(0, EVIDENCE_MAX) } : {}),
    ...(typeof value.dueAt === "number" && Number.isFinite(value.dueAt) ? { dueAt: value.dueAt } : {}),
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
  };
}

function normalizeVerdict(value: unknown): BoardTaskVerdictRecord | undefined {
  if (!isRecord(value) || !oneOf(value.decision, BOARD_VERDICTS) || typeof value.evidence !== "string" || !value.evidence.trim()) return undefined;
  return { decision: value.decision, evidence: value.evidence.trim().slice(0, EVIDENCE_MAX), at: typeof value.at === "string" ? value.at : new Date(0).toISOString() };
}

function normalizeTask(value: unknown): BoardTask | null {
  if (!isRecord(value) || typeof value.threadId !== "string" || !ID.test(value.threadId) ||
    typeof value.botId !== "string" || !ID.test(value.botId) ||
    !oneOf(value.phase, BOARD_PHASES) || !oneOf(value.status, BOARD_TASK_STATUSES)) return null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  const verdict = normalizeVerdict(value.verdict);
  return {
    threadId: value.threadId,
    botId: value.botId,
    ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}),
    ...(typeof value.subprojectId === "string" ? { subprojectId: value.subprojectId } : {}),
    ...(typeof value.parentThreadId === "string" && value.parentThreadId !== value.threadId ? { parentThreadId: value.parentThreadId } : {}),
    phase: value.phase,
    status: value.status,
    ...(typeof value.owner === "string" && value.owner.trim() ? { owner: value.owner.trim().slice(0, OWNER_MAX) } : {}),
    ...(typeof value.acceptance === "string" && value.acceptance.trim() ? { acceptance: value.acceptance.trim().slice(0, ACCEPTANCE_MAX) } : {}),
    ...(value.blocked === true ? { blocked: true } : {}),
    ...(value.paused === true ? { paused: true } : {}),
    ...(verdict ? { verdict } : {}),
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
  };
}

/** Drop references whose parent is gone, and a parent chain that loops. A hand-edited file never crashes the server. */
function repair(board: BoardState): void {
  const projects = new Set(board.projects.map((project) => project.id));
  const subprojects = new Map(board.subprojects.map((subproject) => [subproject.id, subproject]));
  board.subprojects = board.subprojects.filter((subproject) => projects.has(subproject.projectId));
  for (const subproject of board.subprojects) subprojects.set(subproject.id, subproject);
  board.milestones = board.milestones.filter((milestone) => {
    if (!projects.has(milestone.projectId)) return false;
    const subproject = milestone.subprojectId ? subprojects.get(milestone.subprojectId) : undefined;
    if (milestone.subprojectId && (!subproject || subproject.projectId !== milestone.projectId)) return false;
    return true;
  });
  const tasks = new Map(board.tasks.map((task) => [task.threadId, task]));
  board.tasks = board.tasks.filter((task) => {
    if (task.projectId && !projects.has(task.projectId)) return false;
    const subproject = task.subprojectId ? subprojects.get(task.subprojectId) : undefined;
    if (task.subprojectId && (!subproject || (task.projectId && subproject.projectId !== task.projectId))) return false;
    const parent = task.parentThreadId ? tasks.get(task.parentThreadId) : undefined;
    if (task.parentThreadId && !parent) return false;
    // A task that is its own ancestor would make the tree's walk unbounded.
    let cursor: BoardTask | undefined = parent;
    for (let depth = 0; cursor && depth < 1_000; depth += 1) {
      if (cursor.threadId === task.threadId) return false;
      cursor = cursor.parentThreadId ? tasks.get(cursor.parentThreadId) : undefined;
    }
    return true;
  });
}

export interface BoardStoreOptions {
  file: string;
  broadcast?: (frame: BoardBroadcast) => void;
  now?: () => Date;
}

/** One board per workspace, persisted whole. Every write bumps `version`; a caller that sends the version it read
 * gets a conflict instead of overwriting a newer board. */
export class BoardStore {
  private readonly file: string;
  private readonly options: BoardStoreOptions;
  private data: BoardState | null = null;

  constructor(options: BoardStoreOptions) {
    this.options = options;
    this.file = options.file;
  }

  private now(): string {
    return nowIso(this.options.now ?? (() => new Date()));
  }

  private load(): BoardState {
    if (this.data) return this.data;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`board: unreadable, starting empty (${String(error)})`);
      this.data = emptyBoard();
      return this.data;
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.subprojects) ||
      !Array.isArray(parsed.milestones) || !Array.isArray(parsed.tasks)) {
      console.warn("board: unexpected shape, starting empty");
      this.data = emptyBoard();
      return this.data;
    }
    const board: BoardState = {
      version: Number.isSafeInteger(parsed.boardVersion) && (parsed.boardVersion as number) >= 0 ? (parsed.boardVersion as number) : 0,
      projects: parsed.projects.map(normalizeProject).filter((project): project is BoardProject => project !== null),
      subprojects: parsed.subprojects.map(normalizeSubproject).filter((subproject): subproject is BoardSubproject => subproject !== null),
      milestones: parsed.milestones.map(normalizeMilestone).filter((milestone): milestone is BoardMilestone => milestone !== null),
      tasks: parsed.tasks.map(normalizeTask).filter((task): task is BoardTask => task !== null),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
    // One classification per conversation; the last one a person set wins after a hand edit.
    const seen = new Set<string>();
    board.tasks = board.tasks.filter((task) => (seen.has(task.threadId) ? false : (seen.add(task.threadId), true)));
    repair(board);
    this.data = board;
    return board;
  }

  private persist(): void {
    const board = this.load();
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const { version, projects, subprojects, milestones, tasks, updatedAt } = board;
    writeFileAtomic(this.file, JSON.stringify({ version: 1, boardVersion: version, projects, subprojects, milestones, tasks, updatedAt }), { mode: 0o600 });
  }

  private changed<T>(result: T): T {
    this.persist();
    this.options.broadcast?.({ kind: "board", board: this.stateOnly() });
    return result;
  }

  /** The board without a caller's `capabilities`; what a broadcast carries. */
  private stateOnly(): BoardState {
    const { version, projects, subprojects, milestones, tasks, updatedAt } = this.load();
    return structuredClone({ version, projects, subprojects, milestones, tasks, updatedAt });
  }

  state(): BoardState {
    return this.stateOnly();
  }

  snapshot(manage: boolean): BoardSnapshot {
    return { ...this.stateOnly(), capabilities: { manage } };
  }

  version(): number {
    return this.load().version;
  }

  /** A write that names the version it read: stale means the caller edits a board someone else has moved. */
  private checkVersion(expected: number | undefined): void {
    if (expected === undefined) return;
    const current = this.load().version;
    if (expected !== current) throw new BoardError("BOARD_VERSION_CONFLICT", `the board is at version ${current}, not ${expected}`);
  }

  private commit<T>(expectedVersion: number | undefined, change: (board: BoardState) => T): T {
    this.checkVersion(expectedVersion);
    const current = this.load();
    // A rejected write must leave the in-memory board exactly as it was: apply on a draft, then swap it in.
    const draft = structuredClone(current);
    const result = change(draft);
    draft.version = current.version + 1;
    draft.updatedAt = this.now();
    repair(draft);
    const previous = this.data;
    this.data = draft;
    try {
      return this.changed(result);
    } catch (error) {
      this.data = previous;
      throw error;
    }
  }

  createProject(input: { name?: unknown; description?: unknown; version?: unknown }): BoardProject {
    const name = cleanText(input.name, "name", NAME_MAX, true);
    const description = cleanText(input.description, "description", DESCRIPTION_MAX);
    const version = cleanVersion(input.version);
    const at = this.now();
    return this.commit(version, (board) => {
      const project: BoardProject = { id: `p_${newId()}`, name, ...(description ? { description } : {}), createdAt: at, updatedAt: at };
      board.projects.push(project);
      return structuredClone(project);
    });
  }

  patchProject(id: string, input: { name?: unknown; description?: unknown; version?: unknown }): BoardProject {
    const projectId = cleanId(id, "projectId");
    const version = cleanVersion(input.version);
    const name = input.name === undefined ? undefined : cleanText(input.name, "name", NAME_MAX, true);
    const description = input.description === null ? null : cleanText(input.description, "description", DESCRIPTION_MAX);
    const at = this.now();
    return this.commit(version, (board) => {
      const project = board.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new BoardError("BOARD_INVALID", "no such project");
      if (name !== undefined) project.name = name;
      if (description === null) delete project.description;
      else if (description !== undefined) project.description = description;
      project.updatedAt = at;
      return structuredClone(project);
    });
  }

  createSubproject(input: { projectId?: unknown; name?: unknown; version?: unknown }): BoardSubproject {
    const projectId = cleanId(input.projectId, "projectId");
    const name = cleanText(input.name, "name", NAME_MAX, true);
    const version = cleanVersion(input.version);
    const at = this.now();
    return this.commit(version, (board) => {
      if (!board.projects.some((project) => project.id === projectId)) throw new BoardError("BOARD_INVALID", "no such project");
      const subproject: BoardSubproject = { id: `sp_${newId()}`, projectId, name, createdAt: at, updatedAt: at };
      board.subprojects.push(subproject);
      return structuredClone(subproject);
    });
  }

  patchSubproject(id: string, input: { name?: unknown; version?: unknown }): BoardSubproject {
    const subprojectId = cleanId(id, "subprojectId");
    const version = cleanVersion(input.version);
    const name = input.name === undefined ? undefined : cleanText(input.name, "name", NAME_MAX, true);
    const at = this.now();
    return this.commit(version, (board) => {
      const subproject = board.subprojects.find((candidate) => candidate.id === subprojectId);
      if (!subproject) throw new BoardError("BOARD_INVALID", "no such subproject");
      if (name !== undefined) subproject.name = name;
      subproject.updatedAt = at;
      return structuredClone(subproject);
    });
  }

  createMilestone(input: { projectId?: unknown; subprojectId?: unknown; title?: unknown; dueAt?: unknown; version?: unknown }): BoardMilestone {
    const projectId = cleanId(input.projectId, "projectId");
    const subprojectId = input.subprojectId === undefined || input.subprojectId === null ? undefined : cleanId(input.subprojectId, "subprojectId");
    const title = cleanText(input.title, "title", TITLE_MAX, true);
    const dueAt = cleanTimestamp(input.dueAt, "dueAt");
    const version = cleanVersion(input.version);
    const at = this.now();
    return this.commit(version, (board) => {
      if (!board.projects.some((project) => project.id === projectId)) throw new BoardError("BOARD_INVALID", "no such project");
      if (subprojectId) {
        const subproject = board.subprojects.find((candidate) => candidate.id === subprojectId);
        if (!subproject || subproject.projectId !== projectId) throw new BoardError("BOARD_INVALID", "subproject must belong to this project");
      }
      const milestone: BoardMilestone = {
        id: `ms_${newId()}`, projectId, ...(subprojectId ? { subprojectId } : {}), title, status: "planned",
        ...(dueAt !== undefined ? { dueAt } : {}), createdAt: at, updatedAt: at,
      };
      board.milestones.push(milestone);
      return structuredClone(milestone);
    });
  }

  patchMilestone(id: string, input: { title?: unknown; status?: unknown; verdict?: unknown; evidence?: unknown; dueAt?: unknown; version?: unknown }): BoardMilestone {
    const milestoneId = cleanId(id, "milestoneId");
    const version = cleanVersion(input.version);
    const title = input.title === undefined ? undefined : cleanText(input.title, "title", TITLE_MAX, true);
    const status = input.status === undefined ? undefined : oneOf(input.status, BOARD_MILESTONE_STATUSES) ? input.status : (() => {
      throw new BoardError("BOARD_INVALID", `status must be one of ${BOARD_MILESTONE_STATUSES.join(", ")}`);
    })();
    const verdict = input.verdict === undefined ? undefined : cleanText(input.verdict, "verdict", VERDICT_MAX);
    const evidence = input.evidence === undefined ? undefined : cleanText(input.evidence, "evidence", EVIDENCE_MAX);
    const dueAt = input.dueAt === null ? null : cleanTimestamp(input.dueAt, "dueAt");
    const at = this.now();
    return this.commit(version, (board) => {
      const milestone = board.milestones.find((candidate) => candidate.id === milestoneId);
      if (!milestone) throw new BoardError("BOARD_INVALID", "no such milestone");
      if (title !== undefined) milestone.title = title;
      if (status !== undefined) milestone.status = status;
      if (verdict !== undefined) milestone.verdict = verdict;
      if (evidence !== undefined) milestone.evidence = evidence;
      if (dueAt === null) delete milestone.dueAt;
      else if (dueAt !== undefined) milestone.dueAt = dueAt;
      if (milestone.status === "accepted" && (!milestone.verdict || !milestone.evidence)) {
        throw new BoardError("BOARD_NEEDS_EVIDENCE", "an accepted milestone needs both verdict and evidence");
      }
      milestone.updatedAt = at;
      return structuredClone(milestone);
    });
  }

  /** Attribute one existing conversation; omitted fields keep their current value. */
  putTask(input: {
    threadId?: unknown; botId?: unknown; projectId?: unknown; subprojectId?: unknown; parentThreadId?: unknown;
    phase?: unknown; status?: unknown; owner?: unknown; acceptance?: unknown; blocked?: unknown; paused?: unknown; version?: unknown;
  }): BoardTask {
    const threadId = cleanId(input.threadId, "threadId");
    const botId = cleanId(input.botId, "botId");
    const version = cleanVersion(input.version);
    const projectId = input.projectId === null ? null : input.projectId === undefined ? undefined : cleanId(input.projectId, "projectId");
    const subprojectId = input.subprojectId === null ? null : input.subprojectId === undefined ? undefined : cleanId(input.subprojectId, "subprojectId");
    const parentThreadId = input.parentThreadId === null ? null : input.parentThreadId === undefined ? undefined : cleanId(input.parentThreadId, "parentThreadId");
    const phase = input.phase === undefined ? undefined : oneOf(input.phase, BOARD_PHASES) ? input.phase : (() => {
      throw new BoardError("BOARD_INVALID", `phase must be one of ${BOARD_PHASES.join(", ")}`);
    })();
    const status = input.status === undefined ? undefined : oneOf(input.status, BOARD_TASK_STATUSES) ? input.status : (() => {
      throw new BoardError("BOARD_INVALID", `status must be one of ${BOARD_TASK_STATUSES.join(", ")}`);
    })();
    const owner = input.owner === null ? null : input.owner === undefined ? undefined : cleanText(input.owner, "owner", OWNER_MAX);
    const acceptance = input.acceptance === null ? null : input.acceptance === undefined ? undefined : cleanText(input.acceptance, "acceptance", ACCEPTANCE_MAX);
    const blocked = cleanBoolean(input.blocked, "blocked");
    const paused = cleanBoolean(input.paused, "paused");
    const at = this.now();
    return this.commit(version, (board) => {
      const existing = board.tasks.find((task) => task.threadId === threadId);
      if (existing && existing.botId !== botId) throw new BoardError("BOARD_INVALID", "a conversation cannot move to another bot");
      const nextProject = projectId === null ? undefined : projectId ?? existing?.projectId;
      if (nextProject && !board.projects.some((project) => project.id === nextProject)) throw new BoardError("BOARD_INVALID", "no such project");
      const nextSubproject = projectId === null ? undefined : subprojectId === null ? undefined : subprojectId ?? existing?.subprojectId;
      if (nextSubproject) {
        const subproject = board.subprojects.find((candidate) => candidate.id === nextSubproject);
        if (!subproject) throw new BoardError("BOARD_INVALID", "no such subproject");
        if (nextProject && subproject.projectId !== nextProject) throw new BoardError("BOARD_INVALID", "subproject must belong to this project");
      }
      if (parentThreadId !== null && parentThreadId !== undefined) {
        if (parentThreadId === threadId) throw new BoardError("BOARD_INVALID", "a task cannot be its own parent");
        if (!board.tasks.some((task) => task.threadId === parentThreadId)) throw new BoardError("BOARD_INVALID", "parentThreadId must be a board task");
        let cursor = board.tasks.find((task) => task.threadId === parentThreadId);
        for (let depth = 0; cursor && depth < 1_000; depth += 1) {
          if (cursor.threadId === threadId) throw new BoardError("BOARD_INVALID", "that parent chain loops back to this task");
          cursor = cursor.parentThreadId ? board.tasks.find((task) => task.threadId === cursor!.parentThreadId) : undefined;
        }
      }
      const next: BoardTask = existing ?? {
        threadId, botId, phase: "discovery", status: "todo", createdAt: at, updatedAt: at,
      };
      if (projectId === null) delete next.projectId;
      else if (projectId !== undefined) next.projectId = projectId;
      if (nextSubproject === undefined) delete next.subprojectId;
      else next.subprojectId = nextSubproject;
      if (parentThreadId === null) delete next.parentThreadId;
      else if (parentThreadId !== undefined) next.parentThreadId = parentThreadId;
      if (phase !== undefined) next.phase = phase;
      if (status !== undefined) next.status = status;
      if (owner === null) delete next.owner;
      else if (owner !== undefined) next.owner = owner;
      if (acceptance === null) delete next.acceptance;
      else if (acceptance !== undefined) next.acceptance = acceptance;
      if (blocked === false) delete next.blocked;
      else if (blocked === true) next.blocked = true;
      if (paused === false) delete next.paused;
      else if (paused === true) next.paused = true;
      if (next.phase === "done" && next.verdict?.decision !== "accepted") {
        throw new BoardError("BOARD_NEEDS_EVIDENCE", "done needs an accepted verdict with evidence");
      }
      next.updatedAt = at;
      if (!existing) board.tasks.push(next);
      return structuredClone(next);
    });
  }

  /** A person's completion verdict; accepted moves the task to done in the same write. */
  verdict(threadId: string, input: { decision?: unknown; evidence?: unknown; version?: unknown }): BoardTask {
    const id = cleanId(threadId, "threadId");
    const version = cleanVersion(input.version);
    const decision = oneOf(input.decision, BOARD_VERDICTS) ? input.decision : (() => {
      throw new BoardError("BOARD_INVALID", `decision must be one of ${BOARD_VERDICTS.join(", ")}`);
    })();
    const evidence = cleanText(input.evidence, "evidence", EVIDENCE_MAX, true);
    const at = this.now();
    return this.commit(version, (board) => {
      const task = board.tasks.find((candidate) => candidate.threadId === id);
      if (!task) throw new BoardError("BOARD_INVALID", "no such board task");
      task.verdict = { decision, evidence, at };
      if (decision === "accepted") {
        task.phase = "done";
        task.status = "done";
      } else {
        if (task.status === "done") task.status = "review";
        if (task.phase === "done") task.phase = "release_ready";
      }
      task.updatedAt = at;
      return structuredClone(task);
    });
  }

  /** Unclassify: the conversation stays, its board row goes, and it shows in the unclassified filter again. */
  removeTask(threadId: string, input: { version?: unknown }): boolean {
    const id = cleanId(threadId, "threadId");
    const version = cleanVersion(input.version);
    return this.commit(version, (board) => {
      const index = board.tasks.findIndex((task) => task.threadId === id);
      if (index < 0) return false;
      const [removed] = board.tasks.splice(index, 1);
      for (const task of board.tasks) if (task.parentThreadId === removed!.threadId) delete task.parentThreadId;
      return true;
    });
  }
}
