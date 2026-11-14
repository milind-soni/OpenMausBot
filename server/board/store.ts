// The board's store: one workspace-wide board.json, written whole. Bots' `projects` are folders and stay
// separate; a board task only points at an existing conversation by botId + threadId.
import { constants, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  BOARD_MILESTONE_STATUSES, BOARD_PHASES, BOARD_PROJECT_STATUSES, BOARD_TASK_STATUSES, BOARD_VERDICTS,
  type BoardAuditEntry, type BoardBroadcast, type BoardMilestone, type BoardPhase, type BoardProject, type BoardProjectStatus,
  type BoardSnapshot, type BoardState, type BoardSubproject, type BoardTask, type BoardTaskStatus, type BoardTaskVerdictRecord,
  type BoardVisibility,
} from "../../shared/board.ts";
import { writeFileAtomic } from "../atomic.ts";
import { newId } from "../contracts.ts";

export const BOARD_FILE = "board.json";
export const BOARD_FILE_VERSION = 2;

export type BoardErrorCode =
  | "BOARD_INVALID" | "BOARD_FORBIDDEN" | "BOARD_VERSION_CONFLICT" | "BOARD_NEEDS_EVIDENCE" | "BOARD_UNAVAILABLE" | "BOARD_BATCH_CONFLICT";

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
  BOARD_UNAVAILABLE: 503,
  BOARD_BATCH_CONFLICT: 409,
};

export interface BoardBatchFailure {
  threadId: string;
  code: BoardErrorCode;
  message: string;
}

export class BoardBatchError extends BoardError {
  readonly failures: BoardBatchFailure[];
  constructor(failures: BoardBatchFailure[]) {
    const detail = failures.slice(0, 3).map((failure) => `${failure.threadId}: ${failure.message}`).join("; ");
    super("BOARD_BATCH_CONFLICT", `${failures.length === 1 ? "one conversation cannot be linked" : `${failures.length} conversations cannot be linked`}: ${detail}`.slice(0, 1_000));
    this.name = "BoardBatchError";
    this.failures = failures;
  }
}

export interface BoardActor {
  label: string;
  email?: string;
}

const SYSTEM_ACTOR: BoardActor = { label: "system" };
const MAX_AUDIT = 10_000;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 2_000;
const TITLE_MAX = 200;
const OWNER_MAX = 80;
const EMAIL_MAX = 320;
const ACCEPTANCE_MAX = 4_000;
const EVIDENCE_MAX = 4_000;
const VERDICT_MAX = 2_000;
const REASON_MAX = 4_000;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENTRY = /^(?:[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+|@[^\s@,;<>"]+\.[^\s@,;<>"]+)$/;
const AUDIT_ACTIONS = [
  "project.create", "project.update", "subproject.create", "subproject.update",
  "milestone.create", "milestone.update", "task.link", "task.update", "task.verdict", "task.remove", "task.batch",
] as const;
const PHASE_REFERENCE = /^(?:https?:\/\/|receipt:|回执[:：]|验收[:：])/i;

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

function cleanEmail(value: unknown, field = "ownerEmail"): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length > EMAIL_MAX || !EMAIL.test(value.trim())) {
    throw new BoardError("BOARD_INVALID", `${field} must be an email address`);
  }
  return value.trim().toLowerCase();
}

function cleanStatus(value: unknown): BoardProjectStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (!oneOf(value, BOARD_PROJECT_STATUSES)) throw new BoardError("BOARD_INVALID", `status must be one of ${BOARD_PROJECT_STATUSES.join(", ")}`);
  return value;
}

/** A phase past discovery is a claim about the product, so it needs a recorded basis; live/done needs a receipt or
 * a named business acceptance, never just a status word. */
function checkPhaseEvidence(phase: string, evidence: string | undefined): void {
  if (phase === "discovery") return;
  if (!evidence) throw new BoardError("BOARD_NEEDS_EVIDENCE", `phase ${phase} needs phaseEvidence`);
  if ((phase === "live_unverified" || phase === "done") && !PHASE_REFERENCE.test(evidence)) {
    throw new BoardError("BOARD_NEEDS_EVIDENCE", `phase ${phase} needs an online receipt or business acceptance reference`);
  }
}

/** A damaged stored audience fails closed to admins, never to everyone. A request body with a bad audience is rejected. */
export function cleanVisibility(value: unknown): BoardVisibility {
  if (value === "everyone" || value === "admins") return value;
  if (isRecord(value) && Array.isArray(value.people)) {
    const people: string[] = [];
    for (const raw of value.people) {
      if (typeof raw !== "string") throw new BoardError("BOARD_INVALID", "visibility people must be email addresses or @domains");
      const entry = raw.trim().toLowerCase();
      if (!entry) continue;
      if (!ENTRY.test(entry) || entry.length > EMAIL_MAX) throw new BoardError("BOARD_INVALID", `"${raw.slice(0, 80)}" is not an email address or @domain`);
      if (!people.includes(entry)) people.push(entry);
    }
    if (people.length > 500) throw new BoardError("BOARD_INVALID", "visibility names more than 500 people");
    return people.length ? { people } : "admins";
  }
  throw new BoardError("BOARD_INVALID", 'visibility must be "everyone", "admins", or { "people": [...] }');
}

function storedVisibility(value: unknown): BoardVisibility {
  try {
    return cleanVisibility(value);
  } catch {
    return "admins";
  }
}

function normalizeProject(value: unknown): BoardProject | null {
  if (!isRecord(value) || typeof value.id !== "string" || !ID.test(value.id) || typeof value.name !== "string" || !value.name.trim()) return null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  const ownerEmail = typeof value.ownerEmail === "string" && value.ownerEmail.trim() ? value.ownerEmail.trim().toLowerCase() : undefined;
  const owner = typeof value.owner === "string" && value.owner.trim() ? value.owner.trim().slice(0, OWNER_MAX) : undefined;
  const goal = typeof value.goal === "string" && value.goal.trim() ? value.goal.trim().slice(0, ACCEPTANCE_MAX) : undefined;
  const acceptance = typeof value.acceptance === "string" && value.acceptance.trim() ? value.acceptance.trim().slice(0, ACCEPTANCE_MAX) : undefined;
  return {
    id: value.id,
    name: value.name.trim().slice(0, NAME_MAX),
    ...(typeof value.description === "string" && value.description.trim() ? { description: value.description.trim().slice(0, DESCRIPTION_MAX) } : {}),
    ...(owner ? { owner } : {}),
    ...(ownerEmail ? { ownerEmail } : {}),
    ...(goal ? { goal } : {}),
    ...(acceptance ? { acceptance } : {}),
    status: oneOf(value.status, BOARD_PROJECT_STATUSES) ? value.status : "active",
    visibility: storedVisibility(value.visibility),
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
  };
}

function normalizeSubproject(value: unknown): BoardSubproject | null {
  if (!isRecord(value) || typeof value.id !== "string" || !ID.test(value.id) || typeof value.projectId !== "string" ||
    typeof value.name !== "string" || !value.name.trim()) return null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  const ownerEmail = typeof value.ownerEmail === "string" && value.ownerEmail.trim() ? value.ownerEmail.trim().toLowerCase() : undefined;
  const owner = typeof value.owner === "string" && value.owner.trim() ? value.owner.trim().slice(0, OWNER_MAX) : undefined;
  const storedEvidence = typeof value.phaseEvidence === "string" && value.phaseEvidence.trim() ? value.phaseEvidence.trim().slice(0, ACCEPTANCE_MAX) : undefined;
  const deliverable = typeof value.deliverable === "string" && value.deliverable.trim() ? value.deliverable.trim().slice(0, ACCEPTANCE_MAX) : undefined;
  const acceptance = typeof value.acceptance === "string" && value.acceptance.trim() ? value.acceptance.trim().slice(0, ACCEPTANCE_MAX) : undefined;
  const storedPhase = oneOf(value.phase, BOARD_PHASES) ? value.phase : "discovery";
  const phaseEvidence = storedPhase !== "discovery" && storedEvidence && (storedPhase !== "live_unverified" && storedPhase !== "done" || PHASE_REFERENCE.test(storedEvidence)) ? storedEvidence : undefined;
  return {
    id: value.id,
    projectId: value.projectId,
    name: value.name.trim().slice(0, NAME_MAX),
    phase: phaseEvidence || storedPhase === "discovery" ? storedPhase : "discovery",
    ...(phaseEvidence ? { phaseEvidence } : {}),
    ...(owner ? { owner } : {}),
    ...(ownerEmail ? { ownerEmail } : {}),
    ...(deliverable ? { deliverable } : {}),
    ...(acceptance ? { acceptance } : {}),
    status: oneOf(value.status, BOARD_PROJECT_STATUSES) ? value.status : "active",
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
  };
}

function normalizeMilestone(value: unknown): BoardMilestone | null {
  if (!isRecord(value) || typeof value.id !== "string" || !ID.test(value.id) || typeof value.projectId !== "string" ||
    typeof value.title !== "string" || !value.title.trim() || !oneOf(value.status, BOARD_MILESTONE_STATUSES)) return null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  const ownerEmail = typeof value.ownerEmail === "string" && value.ownerEmail.trim() ? value.ownerEmail.trim().toLowerCase() : undefined;
  const owner = typeof value.owner === "string" && value.owner.trim() ? value.owner.trim().slice(0, OWNER_MAX) : undefined;
  const acceptance = typeof value.acceptance === "string" && value.acceptance.trim() ? value.acceptance.trim().slice(0, ACCEPTANCE_MAX) : undefined;
  const acceptedBy = typeof value.acceptedBy === "string" && value.acceptedBy.trim() ? value.acceptedBy.trim().slice(0, OWNER_MAX) : undefined;
  return {
    id: value.id,
    projectId: value.projectId,
    ...(typeof value.subprojectId === "string" ? { subprojectId: value.subprojectId } : {}),
    title: value.title.trim().slice(0, TITLE_MAX),
    status: value.status,
    ...(typeof value.verdict === "string" && value.verdict.trim() ? { verdict: value.verdict.trim().slice(0, VERDICT_MAX) } : {}),
    ...(typeof value.evidence === "string" && value.evidence.trim() ? { evidence: value.evidence.trim().slice(0, EVIDENCE_MAX) } : {}),
    ...(acceptedBy ? { acceptedBy } : {}),
    ...(acceptance ? { acceptance } : {}),
    ...(owner ? { owner } : {}),
    ...(ownerEmail ? { ownerEmail } : {}),
    ...(typeof value.dueAt === "number" && Number.isFinite(value.dueAt) ? { dueAt: value.dueAt } : {}),
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
  };
}

function normalizeVerdict(value: unknown): BoardTaskVerdictRecord | undefined {
  if (!isRecord(value) || !oneOf(value.decision, BOARD_VERDICTS) || typeof value.evidence !== "string" || !value.evidence.trim()) return undefined;
  return {
    decision: value.decision,
    evidence: value.evidence.trim().slice(0, EVIDENCE_MAX),
    at: typeof value.at === "string" ? value.at : new Date(0).toISOString(),
    ...(typeof value.by === "string" && value.by.trim() ? { by: value.by.trim().slice(0, OWNER_MAX) } : {}),
  };
}

function normalizeTask(value: unknown): BoardTask | null {
  if (!isRecord(value) || typeof value.threadId !== "string" || !ID.test(value.threadId) ||
    typeof value.botId !== "string" || !ID.test(value.botId) ||
    !oneOf(value.phase, BOARD_PHASES) || !oneOf(value.status, BOARD_TASK_STATUSES)) return null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  const verdict = normalizeVerdict(value.verdict);
  const ownerEmail = typeof value.ownerEmail === "string" && value.ownerEmail.trim() ? value.ownerEmail.trim().toLowerCase() : undefined;
  const blockedReason = typeof value.blockedReason === "string" && value.blockedReason.trim() ? value.blockedReason.trim().slice(0, REASON_MAX) : undefined;
  const pausedReason = typeof value.pausedReason === "string" && value.pausedReason.trim() ? value.pausedReason.trim().slice(0, REASON_MAX) : undefined;
  const phaseEvidence = typeof value.phaseEvidence === "string" && value.phaseEvidence.trim() ? value.phaseEvidence.trim().slice(0, ACCEPTANCE_MAX) : undefined;
  return {
    threadId: value.threadId,
    botId: value.botId,
    ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}),
    ...(typeof value.subprojectId === "string" ? { subprojectId: value.subprojectId } : {}),
    ...(typeof value.parentThreadId === "string" && value.parentThreadId !== value.threadId ? { parentThreadId: value.parentThreadId } : {}),
    phase: value.phase,
    ...(phaseEvidence ? { phaseEvidence } : {}),
    status: value.status,
    ...(typeof value.owner === "string" && value.owner.trim() ? { owner: value.owner.trim().slice(0, OWNER_MAX) } : {}),
    ...(ownerEmail ? { ownerEmail } : {}),
    ...(typeof value.acceptance === "string" && value.acceptance.trim() ? { acceptance: value.acceptance.trim().slice(0, ACCEPTANCE_MAX) } : {}),
    ...(value.blocked === true ? { blocked: true } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    ...(value.paused === true ? { paused: true } : {}),
    ...(pausedReason ? { pausedReason } : {}),
    ...(verdict ? { verdict } : {}),
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
  };
}

function normalizeAudit(value: unknown): BoardAuditEntry | null {
  if (!isRecord(value) || typeof value.id !== "string" || !ID.test(value.id) || typeof value.at !== "string" ||
    !oneOf(value.action, AUDIT_ACTIONS) || !isRecord(value.target) || typeof value.target.id !== "string" ||
    !Array.isArray(value.fields) || !isRecord(value.actor) || typeof value.actor.label !== "string") return null;
  const kind = value.target.kind;
  if (kind !== "project" && kind !== "subproject" && kind !== "milestone" && kind !== "task") return null;
  return {
    id: value.id,
    at: value.at,
    actor: { label: value.actor.label.slice(0, OWNER_MAX), ...(typeof value.actor.email === "string" && value.actor.email.trim() ? { email: value.actor.email } : {}) },
    action: value.action,
    target: { kind, id: value.target.id },
    fields: value.fields.filter((field): field is string => typeof field === "string").slice(0, 40).map((field) => field.slice(0, 80)),
    ...(typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count >= 0 ? { count: value.count } : {}),
    ...(typeof value.reason === "string" && value.reason.trim() ? { reason: value.reason.trim().slice(0, 1_000) } : {}),
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

interface AuditDraft {
  action: BoardAuditEntry["action"];
  target: BoardAuditEntry["target"];
  fields: string[];
  actor?: BoardActor;
  count?: number;
  reason?: string;
}

interface TaskWriteInput {
  threadId?: unknown; botId?: unknown; projectId?: unknown; subprojectId?: unknown; parentThreadId?: unknown;
  phase?: unknown; phaseEvidence?: unknown; status?: unknown; owner?: unknown; ownerEmail?: unknown; acceptance?: unknown;
  blocked?: unknown; blockedReason?: unknown; paused?: unknown; pausedReason?: unknown; version?: unknown;
}

interface ParsedTaskWrite {
  threadId: string;
  botId: string;
  projectId?: string | null;
  subprojectId?: string | null;
  parentThreadId?: string | null;
  phase?: BoardPhase;
  phaseEvidence?: string | null;
  status?: BoardTaskStatus;
  owner?: string | null;
  ownerEmail?: string | null;
  acceptance?: string | null;
  blocked?: boolean;
  blockedReason?: string | null;
  paused?: boolean;
  pausedReason?: string | null;
  version?: number;
  fields: string[];
}

function parseTaskWrite(input: TaskWriteInput): ParsedTaskWrite {
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
  const phaseEvidence = input.phaseEvidence === null ? null : input.phaseEvidence === undefined ? undefined : cleanText(input.phaseEvidence, "phaseEvidence", ACCEPTANCE_MAX);
  const owner = input.owner === null ? null : input.owner === undefined ? undefined : cleanText(input.owner, "owner", OWNER_MAX);
  const ownerEmail = input.ownerEmail === null ? null : input.ownerEmail === undefined ? undefined : cleanEmail(input.ownerEmail);
  const acceptance = input.acceptance === null ? null : input.acceptance === undefined ? undefined : cleanText(input.acceptance, "acceptance", ACCEPTANCE_MAX);
  const blocked = cleanBoolean(input.blocked, "blocked");
  const paused = cleanBoolean(input.paused, "paused");
  const blockedReason = input.blockedReason === null ? null : input.blockedReason === undefined ? undefined : cleanText(input.blockedReason, "blockedReason", REASON_MAX);
  const pausedReason = input.pausedReason === null ? null : input.pausedReason === undefined ? undefined : cleanText(input.pausedReason, "pausedReason", REASON_MAX);
  if (blocked === false && blockedReason) throw new BoardError("BOARD_INVALID", "a task that is not blocked cannot carry a blockedReason");
  if (paused === false && pausedReason) throw new BoardError("BOARD_INVALID", "a task that is not paused cannot carry a pausedReason");
  return {
    threadId, botId, projectId, subprojectId, parentThreadId, phase, phaseEvidence, status, owner, ownerEmail, acceptance,
    blocked, blockedReason, paused, pausedReason, version,
    fields: [
      "projectId", "subprojectId", "parentThreadId", "phase", "phaseEvidence", "status", "owner", "ownerEmail", "acceptance",
      "blocked", "blockedReason", "paused", "pausedReason",
    ].filter((field) => input[field as keyof TaskWriteInput] !== undefined),
  };
}

function applyTaskWrite(board: BoardState, write: ParsedTaskWrite, at: string): BoardTask {
  const { threadId, botId, projectId, subprojectId, parentThreadId, phase, phaseEvidence, status, owner, ownerEmail, acceptance, blocked, blockedReason, paused, pausedReason } = write;
  const existing = board.tasks.find((task) => task.threadId === threadId);
  if (existing && existing.botId !== botId) throw new BoardError("BOARD_INVALID", "a conversation cannot move to another bot");
  const phaseChanged = phase !== undefined && phase !== existing?.phase;
  let nextProject = projectId === null ? undefined : projectId ?? existing?.projectId;
  let nextSubproject = projectId === null ? undefined : subprojectId === null ? undefined : subprojectId ?? existing?.subprojectId;
  const nextParent = parentThreadId === null ? undefined : parentThreadId ?? existing?.parentThreadId;
  const parent = nextParent ? board.tasks.find((task) => task.threadId === nextParent) : undefined;
  if (nextParent && !parent) throw new BoardError("BOARD_INVALID", "parentThreadId must be a board task");
  if (projectId === null && nextParent) throw new BoardError("BOARD_INVALID", "an unclassified task cannot have a parent");
  if (parent) {
    if (projectId !== undefined && projectId !== null && parent.projectId !== projectId) {
      throw new BoardError("BOARD_INVALID", "the parent task belongs to another project");
    }
    if (subprojectId !== undefined && subprojectId !== null && parent.subprojectId !== subprojectId) {
      throw new BoardError("BOARD_INVALID", "the parent task belongs to another subproject");
    }
    if (projectId === undefined && parent.projectId !== undefined) nextProject = parent.projectId;
    if (subprojectId === undefined && parent.subprojectId !== undefined) nextSubproject = parent.subprojectId;
    if (parent.projectId === undefined && nextProject !== undefined) throw new BoardError("BOARD_INVALID", "the parent task has no project");
    if (parent.subprojectId === undefined && nextSubproject !== undefined) throw new BoardError("BOARD_INVALID", "the parent task has no subproject");
  }
  if (parent && parent.threadId === threadId) throw new BoardError("BOARD_INVALID", "a task cannot be its own parent");
  if (nextProject && !board.projects.some((project) => project.id === nextProject)) throw new BoardError("BOARD_INVALID", "no such project");
  if (nextSubproject) {
    const subproject = board.subprojects.find((candidate) => candidate.id === nextSubproject);
    if (!subproject) throw new BoardError("BOARD_INVALID", "no such subproject");
    if (nextProject && subproject.projectId !== nextProject) throw new BoardError("BOARD_INVALID", "subproject must belong to this project");
  }
  if (!nextProject && nextSubproject) throw new BoardError("BOARD_INVALID", "a subproject needs a project");
  if (nextParent && !nextProject) throw new BoardError("BOARD_INVALID", "a parent task needs a project");
  if (existing && (existing.projectId !== nextProject || existing.subprojectId !== nextSubproject) &&
    board.tasks.some((task) => task.parentThreadId === threadId)) {
    throw new BoardError("BOARD_INVALID", "move or unlink this task's subtasks before changing its project or subproject");
  }
  if (nextParent) {
    let cursor = parent;
    for (let depth = 0; cursor && depth < 1_000; depth += 1) {
      if (cursor.threadId === threadId) throw new BoardError("BOARD_INVALID", "that parent chain loops back to this task");
      cursor = cursor.parentThreadId ? board.tasks.find((task) => task.threadId === cursor!.parentThreadId) : undefined;
    }
  }
  const next: BoardTask = existing ?? {
    threadId, botId, phase: "discovery", status: "todo", createdAt: at, updatedAt: at,
  };
  if (projectId === null) {
    delete next.projectId;
    delete next.subprojectId;
    delete next.parentThreadId;
  } else {
    if (nextProject === undefined) delete next.projectId;
    else next.projectId = nextProject;
    if (nextSubproject === undefined) delete next.subprojectId;
    else next.subprojectId = nextSubproject;
    if (nextParent === undefined) delete next.parentThreadId;
    else next.parentThreadId = nextParent;
  }
  if (phase !== undefined) next.phase = phase;
  if (status !== undefined) next.status = status;
  if (owner === null) delete next.owner;
  else if (owner !== undefined) next.owner = owner;
  if (ownerEmail === null) delete next.ownerEmail;
  else if (ownerEmail !== undefined) next.ownerEmail = ownerEmail;
  if (acceptance === null) delete next.acceptance;
  else if (acceptance !== undefined) next.acceptance = acceptance;
  if (blocked === false) {
    delete next.blocked;
    delete next.blockedReason;
  } else if (blocked === true) {
    next.blocked = true;
  }
  if (blockedReason === null) {
    delete next.blockedReason;
    if (blocked === undefined) delete next.blocked;
  } else if (blockedReason !== undefined) {
    next.blockedReason = blockedReason;
    next.blocked = true;
  }
  if (paused === false) {
    delete next.paused;
    delete next.pausedReason;
  } else if (paused === true) {
    next.paused = true;
  }
  if (pausedReason === null) {
    delete next.pausedReason;
    if (paused === undefined) delete next.paused;
  } else if (pausedReason !== undefined) {
    next.pausedReason = pausedReason;
    next.paused = true;
  }
  if (phaseChanged && next.phase === "done" && !phaseEvidence) {
    throw new BoardError("BOARD_NEEDS_EVIDENCE", "moving a task phase to done needs phaseEvidence");
  }
  if (phaseEvidence === null && next.phase === "done") {
    throw new BoardError("BOARD_NEEDS_EVIDENCE", "a done task cannot drop its phaseEvidence");
  }
  if (phaseEvidence !== null && phaseEvidence !== undefined) next.phaseEvidence = phaseEvidence;
  else if (phaseEvidence === null) delete next.phaseEvidence;
  if (next.status === "done" && next.verdict?.decision !== "accepted") {
    throw new BoardError("BOARD_NEEDS_EVIDENCE", "a done task needs an accepted verdict with evidence");
  }
  next.updatedAt = at;
  if (!existing) board.tasks.push(next);
  return structuredClone(next);
}

export interface BoardBatchLink {
  threadId: string;
  botId: string;
  ownerEmail?: string;
}


/** One board per workspace, persisted whole. Every write bumps `version`; a caller that sends the version it read
 * gets a conflict instead of overwriting a newer board. */
export class BoardStore {
  private readonly file: string;
  private readonly options: BoardStoreOptions;
  private data: BoardState | null = null;
  private auditEntries: BoardAuditEntry[] = [];
  private migratedFrom: number | null = null;

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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new BoardError("BOARD_UNAVAILABLE", "the board file cannot be read; it was left untouched");
      }
      this.data = emptyBoard();
      return this.data;
    }
    if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== BOARD_FILE_VERSION) ||
      !Array.isArray(parsed.projects) || !Array.isArray(parsed.subprojects) ||
      !Array.isArray(parsed.milestones) || !Array.isArray(parsed.tasks)) {
      const version = isRecord(parsed) && typeof parsed.version === "number" ? ` ${parsed.version}` : "";
      throw new BoardError("BOARD_UNAVAILABLE", `the board file${version ? ` version${version}` : ""} is not supported; it was left untouched`);
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
    this.auditEntries = parsed.version === BOARD_FILE_VERSION && Array.isArray(parsed.audit)
      ? parsed.audit.map(normalizeAudit).filter((entry): entry is BoardAuditEntry => entry !== null).slice(-MAX_AUDIT)
      : [];
    this.migratedFrom = parsed.version === 1 ? 1 : null;
    return board;
  }

  private persist(): void {
    const board = this.load();
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    if (this.migratedFrom !== null) {
      try {
        copyFileSync(this.file, `${this.file}.v${this.migratedFrom}.bak`, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new BoardError("BOARD_UNAVAILABLE", "the board file could not be backed up before migration; it was left untouched");
        }
      }
    }
    const { version, projects, subprojects, milestones, tasks, updatedAt } = board;
    writeFileAtomic(this.file, JSON.stringify({
      version: BOARD_FILE_VERSION, boardVersion: version, projects, subprojects, milestones, tasks, audit: this.auditEntries, updatedAt,
    }), { mode: 0o600 });
    this.migratedFrom = null;
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

  audit(limit = 100): BoardAuditEntry[] {
    this.load();
    if (!Number.isSafeInteger(limit) || limit < 1) throw new BoardError("BOARD_INVALID", "limit must be a positive whole number");
    return structuredClone(this.auditEntries.slice(-Math.min(limit, 500)));
  }

  /** A write that names the version it read: stale means the caller edits a board someone else has moved. */
  private checkVersion(expected: number | undefined): void {
    if (expected === undefined) return;
    const current = this.load().version;
    if (expected !== current) throw new BoardError("BOARD_VERSION_CONFLICT", `the board is at version ${current}, not ${expected}`);
  }

  private commit<T>(expectedVersion: number | undefined, audit: AuditDraft, change: (board: BoardState) => T): T {
    this.checkVersion(expectedVersion);
    const current = this.load();
    // A rejected write must leave the in-memory board exactly as it was: apply on a draft, then swap it in.
    const draft = structuredClone(current);
    const result = change(draft);
    draft.version = current.version + 1;
    draft.updatedAt = this.now();
    repair(draft);
    const entry: BoardAuditEntry = {
      id: `a_${newId()}`,
      at: draft.updatedAt,
      actor: audit.actor ?? SYSTEM_ACTOR,
      action: audit.action,
      target: audit.target,
      fields: [...new Set(audit.fields)].slice(0, 40),
      ...(audit.count !== undefined ? { count: audit.count } : {}),
      ...(audit.reason ? { reason: audit.reason.slice(0, 1_000) } : {}),
    };
    const previous = this.data;
    const previousAudit = this.auditEntries;
    this.data = draft;
    this.auditEntries = [...this.auditEntries, entry].slice(-MAX_AUDIT);
    try {
      return this.changed(result);
    } catch (error) {
      this.data = previous;
      this.auditEntries = previousAudit;
      throw error;
    }
  }

  createProject(input: {
    name?: unknown; description?: unknown; owner?: unknown; ownerEmail?: unknown; goal?: unknown; acceptance?: unknown;
    status?: unknown; visibility?: unknown; version?: unknown;
  }, actor: BoardActor = SYSTEM_ACTOR): BoardProject {
    const name = cleanText(input.name, "name", NAME_MAX, true);
    const description = cleanText(input.description, "description", DESCRIPTION_MAX);
    const owner = cleanText(input.owner, "owner", OWNER_MAX);
    const ownerEmail = cleanEmail(input.ownerEmail);
    const goal = cleanText(input.goal, "goal", ACCEPTANCE_MAX);
    const acceptance = cleanText(input.acceptance, "acceptance", ACCEPTANCE_MAX);
    const status = cleanStatus(input.status) ?? "active";
    const visibility = input.visibility === undefined ? "admins" : cleanVisibility(input.visibility);
    const version = cleanVersion(input.version);
    const at = this.now();
    const id = `p_${newId()}`;
    return this.commit(version, {
      action: "project.create", target: { kind: "project", id }, actor,
      fields: ["name", "description", "owner", "ownerEmail", "goal", "acceptance", "status", "visibility"].filter((field) => {
        const key = field as keyof typeof input;
        return input[key] !== undefined;
      }),
    }, (board) => {
      const project: BoardProject = {
        id, name, ...(description ? { description } : {}), ...(owner ? { owner } : {}),
        ...(ownerEmail ? { ownerEmail } : {}), ...(goal ? { goal } : {}), ...(acceptance ? { acceptance } : {}),
        status, visibility, createdAt: at, updatedAt: at,
      };
      board.projects.push(project);
      return structuredClone(project);
    });
  }

  patchProject(id: string, input: {
    name?: unknown; description?: unknown; owner?: unknown; ownerEmail?: unknown; goal?: unknown; acceptance?: unknown;
    status?: unknown; visibility?: unknown; version?: unknown;
  }, actor: BoardActor = SYSTEM_ACTOR): BoardProject {
    const projectId = cleanId(id, "projectId");
    const version = cleanVersion(input.version);
    const name = input.name === undefined ? undefined : cleanText(input.name, "name", NAME_MAX, true);
    const description = input.description === null ? null : cleanText(input.description, "description", DESCRIPTION_MAX);
    const owner = input.owner === null ? null : cleanText(input.owner, "owner", OWNER_MAX);
    const ownerEmail = input.ownerEmail === null ? null : cleanEmail(input.ownerEmail);
    const goal = input.goal === null ? null : cleanText(input.goal, "goal", ACCEPTANCE_MAX);
    const acceptance = input.acceptance === null ? null : cleanText(input.acceptance, "acceptance", ACCEPTANCE_MAX);
    const status = cleanStatus(input.status);
    const visibility = input.visibility === undefined ? undefined : cleanVisibility(input.visibility);
    const at = this.now();
    return this.commit(version, {
      action: "project.update", target: { kind: "project", id: projectId }, actor,
      fields: ["name", "description", "owner", "ownerEmail", "goal", "acceptance", "status", "visibility"].filter((field) => input[field as keyof typeof input] !== undefined),
    }, (board) => {
      const project = board.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new BoardError("BOARD_INVALID", "no such project");
      if (name !== undefined) project.name = name;
      if (description === null) delete project.description;
      else if (description !== undefined) project.description = description;
      if (owner === null) delete project.owner;
      else if (owner !== undefined) project.owner = owner;
      if (ownerEmail === null) delete project.ownerEmail;
      else if (ownerEmail !== undefined) project.ownerEmail = ownerEmail;
      if (goal === null) delete project.goal;
      else if (goal !== undefined) project.goal = goal;
      if (acceptance === null) delete project.acceptance;
      else if (acceptance !== undefined) project.acceptance = acceptance;
      if (status !== undefined) project.status = status;
      if (visibility !== undefined) project.visibility = visibility;
      project.updatedAt = at;
      return structuredClone(project);
    });
  }

  createSubproject(input: {
    projectId?: unknown; name?: unknown; phase?: unknown; phaseEvidence?: unknown; owner?: unknown; ownerEmail?: unknown;
    deliverable?: unknown; acceptance?: unknown; status?: unknown; version?: unknown;
  }, actor: BoardActor = SYSTEM_ACTOR): BoardSubproject {
    const projectId = cleanId(input.projectId, "projectId");
    const name = cleanText(input.name, "name", NAME_MAX, true);
    const phase = input.phase === undefined ? "discovery" : oneOf(input.phase, BOARD_PHASES) ? input.phase : (() => {
      throw new BoardError("BOARD_INVALID", `phase must be one of ${BOARD_PHASES.join(", ")}`);
    })();
    const phaseEvidence = cleanText(input.phaseEvidence, "phaseEvidence", ACCEPTANCE_MAX);
    checkPhaseEvidence(phase, phaseEvidence);
    const owner = cleanText(input.owner, "owner", OWNER_MAX);
    const ownerEmail = cleanEmail(input.ownerEmail);
    const deliverable = cleanText(input.deliverable, "deliverable", ACCEPTANCE_MAX);
    const acceptance = cleanText(input.acceptance, "acceptance", ACCEPTANCE_MAX);
    const status = cleanStatus(input.status) ?? "active";
    const version = cleanVersion(input.version);
    const at = this.now();
    const id = `sp_${newId()}`;
    return this.commit(version, {
      action: "subproject.create", target: { kind: "subproject", id }, actor,
      fields: ["projectId", "name", "phase", "phaseEvidence", "owner", "ownerEmail", "deliverable", "acceptance", "status"].filter((field) => input[field as keyof typeof input] !== undefined),
    }, (board) => {
      if (!board.projects.some((project) => project.id === projectId)) throw new BoardError("BOARD_INVALID", "no such project");
      const subproject: BoardSubproject = {
        id, projectId, name, phase, ...(phaseEvidence ? { phaseEvidence } : {}), ...(owner ? { owner } : {}),
        ...(ownerEmail ? { ownerEmail } : {}), ...(deliverable ? { deliverable } : {}), ...(acceptance ? { acceptance } : {}),
        status, createdAt: at, updatedAt: at,
      };
      board.subprojects.push(subproject);
      return structuredClone(subproject);
    });
  }

  patchSubproject(id: string, input: {
    name?: unknown; phase?: unknown; phaseEvidence?: unknown; owner?: unknown; ownerEmail?: unknown;
    deliverable?: unknown; acceptance?: unknown; status?: unknown; version?: unknown;
  }, actor: BoardActor = SYSTEM_ACTOR): BoardSubproject {
    const subprojectId = cleanId(id, "subprojectId");
    const version = cleanVersion(input.version);
    const name = input.name === undefined ? undefined : cleanText(input.name, "name", NAME_MAX, true);
    const phase = input.phase === undefined ? undefined : oneOf(input.phase, BOARD_PHASES) ? input.phase : (() => {
      throw new BoardError("BOARD_INVALID", `phase must be one of ${BOARD_PHASES.join(", ")}`);
    })();
    const phaseEvidence = input.phaseEvidence === null ? null : cleanText(input.phaseEvidence, "phaseEvidence", ACCEPTANCE_MAX);
    const owner = input.owner === null ? null : cleanText(input.owner, "owner", OWNER_MAX);
    const ownerEmail = input.ownerEmail === null ? null : cleanEmail(input.ownerEmail);
    const deliverable = input.deliverable === null ? null : cleanText(input.deliverable, "deliverable", ACCEPTANCE_MAX);
    const acceptance = input.acceptance === null ? null : cleanText(input.acceptance, "acceptance", ACCEPTANCE_MAX);
    const status = cleanStatus(input.status);
    const at = this.now();
    return this.commit(version, {
      action: "subproject.update", target: { kind: "subproject", id: subprojectId }, actor,
      fields: ["name", "phase", "phaseEvidence", "owner", "ownerEmail", "deliverable", "acceptance", "status"].filter((field) => input[field as keyof typeof input] !== undefined),
    }, (board) => {
      const subproject = board.subprojects.find((candidate) => candidate.id === subprojectId);
      if (!subproject) throw new BoardError("BOARD_INVALID", "no such subproject");
      const phaseChanged = phase !== undefined && phase !== subproject.phase;
      if (phaseChanged && !phaseEvidence) {
        throw new BoardError("BOARD_NEEDS_EVIDENCE", "changing a subproject phase needs phaseEvidence");
      }
      if (phaseChanged) checkPhaseEvidence(phase!, phaseEvidence!);
      if (!phaseChanged && phaseEvidence === null && subproject.phase !== "discovery") {
        throw new BoardError("BOARD_NEEDS_EVIDENCE", "a subproject past discovery cannot drop its phaseEvidence");
      }
      if (!phaseChanged && phaseEvidence !== undefined && phaseEvidence !== null) checkPhaseEvidence(subproject.phase ?? "discovery", phaseEvidence);
      if (name !== undefined) subproject.name = name;
      if (phase !== undefined) subproject.phase = phase;
      if (phaseEvidence === null) delete subproject.phaseEvidence;
      else if (phaseEvidence !== undefined) subproject.phaseEvidence = phaseEvidence;
      if (owner === null) delete subproject.owner;
      else if (owner !== undefined) subproject.owner = owner;
      if (ownerEmail === null) delete subproject.ownerEmail;
      else if (ownerEmail !== undefined) subproject.ownerEmail = ownerEmail;
      if (deliverable === null) delete subproject.deliverable;
      else if (deliverable !== undefined) subproject.deliverable = deliverable;
      if (acceptance === null) delete subproject.acceptance;
      else if (acceptance !== undefined) subproject.acceptance = acceptance;
      if (status !== undefined) subproject.status = status;
      subproject.updatedAt = at;
      return structuredClone(subproject);
    });
  }

  createMilestone(input: {
    projectId?: unknown; subprojectId?: unknown; title?: unknown; dueAt?: unknown; acceptance?: unknown; owner?: unknown;
    ownerEmail?: unknown; version?: unknown;
  }, actor: BoardActor = SYSTEM_ACTOR): BoardMilestone {
    const projectId = cleanId(input.projectId, "projectId");
    const subprojectId = input.subprojectId === undefined || input.subprojectId === null ? undefined : cleanId(input.subprojectId, "subprojectId");
    const title = cleanText(input.title, "title", TITLE_MAX, true);
    const dueAt = cleanTimestamp(input.dueAt, "dueAt");
    const acceptance = cleanText(input.acceptance, "acceptance", ACCEPTANCE_MAX);
    const owner = cleanText(input.owner, "owner", OWNER_MAX);
    const ownerEmail = cleanEmail(input.ownerEmail);
    const version = cleanVersion(input.version);
    const at = this.now();
    const id = `ms_${newId()}`;
    return this.commit(version, {
      action: "milestone.create", target: { kind: "milestone", id }, actor,
      fields: ["projectId", "subprojectId", "title", "dueAt", "acceptance", "owner", "ownerEmail"].filter((field) => input[field as keyof typeof input] !== undefined),
    }, (board) => {
      if (!board.projects.some((project) => project.id === projectId)) throw new BoardError("BOARD_INVALID", "no such project");
      if (subprojectId) {
        const subproject = board.subprojects.find((candidate) => candidate.id === subprojectId);
        if (!subproject || subproject.projectId !== projectId) throw new BoardError("BOARD_INVALID", "subproject must belong to this project");
      }
      const milestone: BoardMilestone = {
        id, projectId, ...(subprojectId ? { subprojectId } : {}), title, status: "planned",
        ...(acceptance ? { acceptance } : {}), ...(owner ? { owner } : {}), ...(ownerEmail ? { ownerEmail } : {}),
        ...(dueAt !== undefined ? { dueAt } : {}), createdAt: at, updatedAt: at,
      };
      board.milestones.push(milestone);
      return structuredClone(milestone);
    });
  }

  patchMilestone(id: string, input: {
    title?: unknown; status?: unknown; verdict?: unknown; evidence?: unknown; dueAt?: unknown; acceptance?: unknown;
    owner?: unknown; ownerEmail?: unknown; version?: unknown;
  }, actor: BoardActor = SYSTEM_ACTOR): BoardMilestone {
    const milestoneId = cleanId(id, "milestoneId");
    const version = cleanVersion(input.version);
    const title = input.title === undefined ? undefined : cleanText(input.title, "title", TITLE_MAX, true);
    const status = input.status === undefined ? undefined : oneOf(input.status, BOARD_MILESTONE_STATUSES) ? input.status : (() => {
      throw new BoardError("BOARD_INVALID", `status must be one of ${BOARD_MILESTONE_STATUSES.join(", ")}`);
    })();
    const verdict = input.verdict === undefined ? undefined : cleanText(input.verdict, "verdict", VERDICT_MAX);
    const evidence = input.evidence === undefined ? undefined : cleanText(input.evidence, "evidence", EVIDENCE_MAX);
    const dueAt = input.dueAt === null ? null : cleanTimestamp(input.dueAt, "dueAt");
    const acceptance = input.acceptance === null ? null : cleanText(input.acceptance, "acceptance", ACCEPTANCE_MAX);
    const owner = input.owner === null ? null : cleanText(input.owner, "owner", OWNER_MAX);
    const ownerEmail = input.ownerEmail === null ? null : cleanEmail(input.ownerEmail);
    const at = this.now();
    return this.commit(version, {
      action: "milestone.update", target: { kind: "milestone", id: milestoneId }, actor,
      fields: ["title", "status", "verdict", "evidence", "dueAt", "acceptance", "owner", "ownerEmail"].filter((field) => input[field as keyof typeof input] !== undefined),
    }, (board) => {
      const milestone = board.milestones.find((candidate) => candidate.id === milestoneId);
      if (!milestone) throw new BoardError("BOARD_INVALID", "no such milestone");
      const wasAccepted = milestone.status === "accepted";
      if (title !== undefined) milestone.title = title;
      if (status !== undefined) milestone.status = status;
      if (verdict !== undefined) milestone.verdict = verdict;
      if (evidence !== undefined) milestone.evidence = evidence;
      if (dueAt === null) delete milestone.dueAt;
      else if (dueAt !== undefined) milestone.dueAt = dueAt;
      if (acceptance === null) delete milestone.acceptance;
      else if (acceptance !== undefined) milestone.acceptance = acceptance;
      if (owner === null) delete milestone.owner;
      else if (owner !== undefined) milestone.owner = owner;
      if (ownerEmail === null) delete milestone.ownerEmail;
      else if (ownerEmail !== undefined) milestone.ownerEmail = ownerEmail;
      if (milestone.status === "accepted") {
        if (!milestone.verdict || !milestone.evidence) {
          throw new BoardError("BOARD_NEEDS_EVIDENCE", "an accepted milestone needs both verdict and evidence");
        }
        if (!wasAccepted || verdict !== undefined || evidence !== undefined) milestone.acceptedBy = actor.label;
      } else {
        delete milestone.acceptedBy;
      }
      milestone.updatedAt = at;
      return structuredClone(milestone);
    });
  }

  /** Attribute one existing conversation; omitted fields keep their current value. */
  putTask(input: TaskWriteInput, actor: BoardActor = SYSTEM_ACTOR): BoardTask {
    const write = parseTaskWrite(input);
    const at = this.now();
    return this.commit(write.version, { action: "task.update", target: { kind: "task", id: write.threadId }, actor, fields: write.fields },
      (board) => applyTaskWrite(board, write, at));
  }

  /** Dry-run every link on one draft; the caller gets per-thread failures and no board mutation. */
  previewBatch(input: { projectId: string; subprojectId?: string; links: BoardBatchLink[] }): BoardBatchFailure[] {
    const projectId = cleanId(input.projectId, "projectId");
    const subprojectId = input.subprojectId === undefined ? undefined : cleanId(input.subprojectId, "subprojectId");
    if (input.links.length > 100) throw new BoardError("BOARD_INVALID", "a batch can link at most 100 conversations");
    const draft = structuredClone(this.load());
    const at = this.now();
    const failures: BoardBatchFailure[] = [];
    for (const link of input.links) {
      try {
        const write = parseTaskWrite({
          threadId: link.threadId, botId: link.botId, projectId, subprojectId,
          ...(link.ownerEmail ? { ownerEmail: link.ownerEmail } : {}),
        });
        applyTaskWrite(draft, write, at);
      } catch (error) {
        if (!(error instanceof BoardError)) throw error;
        failures.push({ threadId: link.threadId, code: error.code, message: error.message });
      }
    }
    return failures;
  }

  /** Link all conversations in one commit; a single bad link leaves every task untouched. */
  batchAssign(input: { projectId: string; subprojectId?: string; links: BoardBatchLink[]; version?: unknown }, actor: BoardActor = SYSTEM_ACTOR): { tasks: BoardTask[]; count: number } {
    const projectId = cleanId(input.projectId, "projectId");
    const subprojectId = input.subprojectId === undefined ? undefined : cleanId(input.subprojectId, "subprojectId");
    const version = cleanVersion(input.version);
    if (version === undefined) throw new BoardError("BOARD_INVALID", "version is required");
    try {
      const failures = this.previewBatch({ projectId, subprojectId, links: input.links });
      if (failures.length) throw new BoardBatchError(failures);
      const at = this.now();
      return this.commit(version, {
        action: "task.batch", target: { kind: "project", id: projectId }, actor,
        fields: ["threadIds", "projectId", "subprojectId"], count: input.links.length,
      }, (board) => {
        const tasks = input.links.map((link) => applyTaskWrite(board, parseTaskWrite({
          threadId: link.threadId, botId: link.botId, projectId, subprojectId,
          ...(link.ownerEmail ? { ownerEmail: link.ownerEmail } : {}),
        }), at));
        return { tasks, count: tasks.length };
      });
    } catch (error) {
      this.recordBatchAudit({ actor, projectId, count: input.links.length, reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /** A failed batch has no task change to commit, but its actor, size and reason still land in the audit. */
  recordBatchAudit(input: { actor: BoardActor; projectId: string; count: number; reason: string }): void {
    try {
      this.load();
      const entry: BoardAuditEntry = {
        id: `a_${newId()}`,
        at: this.now(),
        actor: input.actor,
        action: "task.batch",
        target: { kind: "project", id: input.projectId },
        fields: ["threadIds"],
        count: Math.max(0, Math.trunc(input.count)),
        reason: input.reason.slice(0, 1_000),
      };
      this.auditEntries = [...this.auditEntries, entry].slice(-MAX_AUDIT);
      this.persist();
    } catch (error) {
      console.warn(`board: could not record a failed batch audit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A person's completion verdict; accepted moves the task to done in the same write. */
  verdict(threadId: string, input: { decision?: unknown; evidence?: unknown; version?: unknown }, actor: BoardActor = SYSTEM_ACTOR): BoardTask {
    const id = cleanId(threadId, "threadId");
    const version = cleanVersion(input.version);
    const decision = oneOf(input.decision, BOARD_VERDICTS) ? input.decision : (() => {
      throw new BoardError("BOARD_INVALID", `decision must be one of ${BOARD_VERDICTS.join(", ")}`);
    })();
    const evidence = cleanText(input.evidence, "evidence", EVIDENCE_MAX, true);
    const at = this.now();
    return this.commit(version, { action: "task.verdict", target: { kind: "task", id }, actor, fields: ["verdict", "status"] }, (board) => {
      const task = board.tasks.find((candidate) => candidate.threadId === id);
      if (!task) throw new BoardError("BOARD_INVALID", "no such board task");
      task.verdict = { decision, evidence, at, by: actor.label };
      task.status = decision === "accepted" ? "done" : task.status === "done" ? "review" : task.status;
      task.updatedAt = at;
      return structuredClone(task);
    });
  }

  /** Unclassify: the conversation stays, its board row goes, and it shows in the unclassified filter again. */
  removeTask(threadId: string, input: { version?: unknown }, actor: BoardActor = SYSTEM_ACTOR): boolean {
    const id = cleanId(threadId, "threadId");
    const version = cleanVersion(input.version);
    return this.commit(version, { action: "task.remove", target: { kind: "task", id }, actor, fields: ["threadId"] }, (board) => {
      const index = board.tasks.findIndex((task) => task.threadId === id);
      if (index < 0) return false;
      const [removed] = board.tasks.splice(index, 1);
      for (const task of board.tasks) if (task.parentThreadId === removed!.threadId) delete task.parentThreadId;
      return true;
    });
  }

  /** A dispatched work conversation becomes a child of the source board task, inheriting its project and subproject. */
  attachDispatch(input: { parentThreadId: string; botId: string; threadId: string; actor?: BoardActor }): BoardTask | null {
    const board = this.load();
    const parent = board.tasks.find((task) => task.threadId === input.parentThreadId);
    if (!parent) return null;
    const existing = board.tasks.find((task) => task.threadId === input.threadId);
    if (existing) return existing;
    const subproject = parent.subprojectId ? board.subprojects.find((candidate) => candidate.id === parent.subprojectId) : undefined;
    const phase = subproject?.phase === "done" || parent.phase === "done" ? "release_ready" : subproject?.phase ?? parent.phase;
    try {
      return this.putTask({
        threadId: input.threadId,
        botId: input.botId,
        ...(parent.projectId ? { projectId: parent.projectId } : {}),
        ...(parent.subprojectId ? { subprojectId: parent.subprojectId } : {}),
        parentThreadId: parent.threadId,
        phase,
        status: "todo",
      }, input.actor ?? SYSTEM_ACTOR);
    } catch (error) {
      if (error instanceof BoardError) return null;
      throw error;
    }
  }
}
