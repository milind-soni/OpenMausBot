// GET /api/board, and the small writes that keep it current. A board row is metadata about a conversation:
// the transcript itself stays behind the conversation routes.
import { PASS, type RouteHandler } from "./table.ts";
import { attachBoardTask, type BoardAttachDeps } from "../board/attach.ts";
import {
  actorFor, boardViewer, conversationVisible, filterBoard, projectEditable, projectVisible, taskEditable,
  type BoardViewer,
} from "../board/access.ts";
import { BoardBatchError, BoardError, boardErrorStatus, type BoardBatchLink, type BoardStore } from "../board/store.ts";
import type { BoardSnapshot } from "../../shared/board.ts";

export interface BoardRouteDeps extends BoardAttachDeps {
  board: BoardStore;
  /** The conversation exists for this bot; a board row never invents one. */
  threadExists(botId: string, threadId: string): boolean;
  /** The conversation's routine provenance, for excluding scheduler runs from work batches. */
  threadInfo(botId: string, threadId: string): { routineRunId?: string } | null;
  /** The caller's existing conversation/bot visibility; absence means the admin-only surface. */
  visibleFor(auth: Parameters<RouteHandler>[0]["auth"]): Parameters<typeof boardViewer>[1];
}

const ROUTE = /^\/api\/board(?:\/audit|\/(projects|subprojects|milestones|tasks)(?:\/([\w-]+))?(?:\/(verdict))?)?$/;
const LIMIT = 64_000;

const PROJECT_FIELDS = new Set(["name", "description", "owner", "ownerEmail", "goal", "acceptance", "status", "visibility", "version"]);
const SUBPROJECT_FIELDS = new Set([
  "projectId", "name", "phase", "phaseEvidence", "owner", "ownerEmail", "deliverable", "acceptance", "status", "version",
]);
const MILESTONE_FIELDS = new Set(["projectId", "subprojectId", "title", "dueAt", "acceptance", "owner", "ownerEmail", "version"]);
const MILESTONE_PATCH_FIELDS = new Set([
  "title", "status", "verdict", "evidence", "dueAt", "acceptance", "owner", "ownerEmail", "version",
]);
const VERDICT_FIELDS = new Set(["decision", "evidence", "version"]);
const BATCH_PATH = "/api/board/tasks/batch";
const BATCH_PREVIEW_PATH = `${BATCH_PATH}/preview`;
const BATCH_FIELDS = new Set(["projectId", "subprojectId", "threads", "version"]);
const BATCH_THREAD_FIELDS = new Set(["threadId", "botId"]);
const BATCH_LIMIT = 100;
const BATCH_ID = /^[A-Za-z0-9_-]{1,80}$/;

type BatchStatus = "ready" | "already_assigned" | "missing" | "hidden" | "routine" | "conflict";
interface BatchItem {
  threadId: string;
  botId: string;
  status: BatchStatus;
  reason?: string;
  existing?: { projectId?: string; subprojectId?: string; parentThreadId?: string };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function unsupported(body: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  return Object.keys(body).find((key) => !allowed.has(key)) ?? null;
}

function missingText(body: Record<string, unknown>, fields: readonly string[]): string | null {
  return fields.find((field) => typeof body[field] !== "string" || !(body[field] as string).trim()) ?? null;
}

function emptiedText(body: Record<string, unknown>, fields: readonly string[]): string | null {
  return fields.find((field) => field in body && (typeof body[field] !== "string" || !(body[field] as string).trim())) ?? null;
}

export function createBoardRoutes(deps: BoardRouteDeps): RouteHandler {
  const fail = (ctx: Parameters<RouteHandler>[0], error: BoardError) =>
    ctx.json(ctx.res, boardErrorStatus[error.code], { error: error.code, message: error.message });
  const invalid = (ctx: Parameters<RouteHandler>[0], message: string, code: "BOARD_INVALID" | "BOARD_FORBIDDEN" = "BOARD_INVALID") =>
    ctx.json(ctx.res, code === "BOARD_FORBIDDEN" ? 403 : 400, { error: code, message });

  const body = async (ctx: Parameters<RouteHandler>[0]): Promise<Record<string, unknown> | null | undefined> => {
    let raw: unknown;
    try {
      raw = await ctx.readBody(ctx.req, LIMIT);
    } catch (error) {
      invalid(ctx, (error as Error).message || "The request body is not JSON.");
      return undefined;
    }
    const parsed = record(raw);
    if (!parsed) {
      invalid(ctx, "body must be a JSON object");
      return undefined;
    }
    return parsed;
  };

  const viewer = (auth: Parameters<RouteHandler>[0]["auth"]): BoardViewer => boardViewer(auth, deps.visibleFor(auth));
  const snapshot = (who: BoardViewer): BoardSnapshot => {
    const filtered = filterBoard(deps.board.state(), who);
    return {
      ...filtered.state,
      capabilities: { manage: who.admin },
      permissions: filtered.permissions,
      counts: filtered.counts,
    };
  };
  const findProject = (id: string) => deps.board.state().projects.find((project) => project.id === id);
  const projectGuard = (ctx: Parameters<RouteHandler>[0], who: BoardViewer, projectId: string | undefined): boolean => {
    const project = projectId ? findProject(projectId) : undefined;
    if (!project || !projectVisible(project, who)) {
      if (projectId) invalid(ctx, "no such project", "BOARD_FORBIDDEN");
      return false;
    }
    return true;
  };
  const editProjectGuard = (ctx: Parameters<RouteHandler>[0], who: BoardViewer, projectId: string | undefined): boolean => {
    const project = projectId ? findProject(projectId) : undefined;
    if (!project || !projectVisible(project, who)) {
      if (projectId) invalid(ctx, "no such project", "BOARD_FORBIDDEN");
      return false;
    }
    if (!projectEditable(project, who)) {
      invalid(ctx, "Only this project's owner can change it.", "BOARD_FORBIDDEN");
      return false;
    }
    return true;
  };

  const handleBatch = async (ctx: Parameters<RouteHandler>[0], who: BoardViewer, preview: boolean): Promise<void> => {
    const input = await body(ctx);
    if (!input) return;
    const extra = unsupported(input, BATCH_FIELDS);
    if (extra) return invalid(ctx, `unsupported field: ${extra}`);

    const projectId = typeof input.projectId === "string" ? input.projectId : "";
    if (!projectId || !BATCH_ID.test(projectId)) return invalid(ctx, "projectId is required");
    if (preview ? !projectGuard(ctx, who, projectId) : !editProjectGuard(ctx, who, projectId)) return;
    const project = findProject(projectId)!;

    let subprojectId: string | undefined;
    if (input.subprojectId !== undefined && input.subprojectId !== null) {
      if (typeof input.subprojectId !== "string" || !BATCH_ID.test(input.subprojectId)) return invalid(ctx, "subprojectId is not a valid id");
      const subproject = deps.board.state().subprojects.find((candidate) => candidate.id === input.subprojectId);
      if (!subproject || subproject.projectId !== projectId) return invalid(ctx, "subproject must belong to this project");
      subprojectId = subproject.id;
    }

    const rawThreads = input.threads;
    if (!Array.isArray(rawThreads) || rawThreads.length < 1 || rawThreads.length > BATCH_LIMIT) {
      return invalid(ctx, `threads must contain 1 to ${BATCH_LIMIT} conversations`);
    }
    const threads: Array<{ threadId: string; botId: string }> = [];
    const seen = new Set<string>();
    for (const raw of rawThreads) {
      const item = record(raw);
      if (!item) return invalid(ctx, "each thread must be an object");
      const extraThread = unsupported(item, BATCH_THREAD_FIELDS);
      if (extraThread) return invalid(ctx, `unsupported thread field: ${extraThread}`);
      const threadId = item.threadId;
      const botId = item.botId;
      if (typeof threadId !== "string" || !BATCH_ID.test(threadId) || typeof botId !== "string" || !BATCH_ID.test(botId)) {
        return invalid(ctx, "threadId and botId must be valid ids");
      }
      if (seen.has(threadId)) return invalid(ctx, `thread ${threadId} appears twice`);
      seen.add(threadId);
      threads.push({ threadId, botId });
    }

    let version: number | undefined;
    if (!preview) {
      if (!Number.isSafeInteger(input.version) || (input.version as number) < 0) return invalid(ctx, "version is required");
      version = input.version as number;
      if (deps.board.version() !== version) {
        const reason = `BOARD_VERSION_CONFLICT: expected ${version}, board is at ${deps.board.version()}`;
        deps.board.recordBatchAudit({ actor: actorFor(ctx.auth), projectId, count: threads.length, reason });
        return ctx.json(ctx.res, 409, { error: "BOARD_VERSION_CONFLICT", message: reason });
      }
    }

    const actor = actorFor(ctx.auth);
    const ownerEmail = who.admin ? undefined : actor.email;
    const state = deps.board.state();
    const items: BatchItem[] = [];
    const links: BoardBatchLink[] = [];
    const existingView = (task: { projectId?: string; subprojectId?: string; parentThreadId?: string }) => ({
      ...(task.projectId ? { projectId: task.projectId } : {}),
      ...(task.subprojectId ? { subprojectId: task.subprojectId } : {}),
      ...(task.parentThreadId ? { parentThreadId: task.parentThreadId } : {}),
    });

    for (const thread of threads) {
      const info = deps.threadInfo(thread.botId, thread.threadId);
      if (!info) {
        items.push({ ...thread, status: "missing", reason: "no such conversation" });
        continue;
      }
      if (!who.visible.thread(thread.threadId) || !who.visible.bot(thread.botId)) {
        items.push({ ...thread, status: "hidden", reason: "no such conversation" });
        continue;
      }
      if (info.routineRunId) {
        items.push({ ...thread, status: "routine", reason: "routine runs are not work conversations" });
        continue;
      }
      const existing = state.tasks.find((task) => task.threadId === thread.threadId);
      if (existing) {
        if (existing.projectId) {
          const existingProject = findProject(existing.projectId);
          if (!existingProject || !projectVisible(existingProject, who)) {
            items.push({ ...thread, status: "hidden", reason: "no such project" });
            continue;
          }
        }
        if (existing.botId !== thread.botId) {
          items.push({ ...thread, status: "conflict", reason: "the board row belongs to another bot", existing: existingView(existing) });
          continue;
        }
        if (existing.projectId !== undefined && existing.projectId !== projectId) {
          items.push({ ...thread, status: "conflict", reason: "already assigned to another project", existing: existingView(existing) });
          continue;
        }
        if (existing.projectId === projectId) {
          const currentSub = existing.subprojectId ?? null;
          const targetSub = subprojectId ?? null;
          if (currentSub === targetSub) {
            items.push({ ...thread, status: "already_assigned", existing: existingView(existing) });
            continue;
          }
          if (existing.subprojectId === undefined && subprojectId !== undefined) {
            // Upgrading a project-level row to the target subproject is a normal link.
          } else {
            items.push({ ...thread, status: "conflict", reason: "already assigned to another subproject", existing: existingView(existing) });
            continue;
          }
        }
      }
      links.push({ ...thread, ...(ownerEmail ? { ownerEmail } : {}) });
      items.push({ ...thread, status: "ready", ...(existing ? { existing: existingView(existing) } : {}) });
    }

    const previewFailures = deps.board.previewBatch({ projectId, subprojectId, links });
    const failureById = new Map(previewFailures.map((failure) => [failure.threadId, failure]));
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const failure = failureById.get(item.threadId);
      if (failure && item.status === "ready") items[index] = { ...item, status: "conflict", reason: failure.message };
    }
    const summary = {
      total: items.length,
      ready: items.filter((item) => item.status === "ready").length,
      alreadyAssigned: items.filter((item) => item.status === "already_assigned").length,
      missing: items.filter((item) => item.status === "missing").length,
      hidden: items.filter((item) => item.status === "hidden").length,
      routine: items.filter((item) => item.status === "routine").length,
      conflict: items.filter((item) => item.status === "conflict").length,
    };
    const target = {
      projectId, projectName: project.name,
      ...(subprojectId ? { subprojectId, subprojectName: state.subprojects.find((candidate) => candidate.id === subprojectId)!.name } : {}),
    };
    if (preview) return ctx.json(ctx.res, 200, { version: deps.board.version(), target, items, summary });

    const blocked = items.filter((item) => item.status !== "ready" && item.status !== "already_assigned");
    if (blocked.length) {
      const reason = `batch refused: ${Object.entries(summary).filter(([key]) => key !== "total" && key !== "ready" && key !== "alreadyAssigned" && summary[key as keyof typeof summary] > 0).map(([key, value]) => `${key}=${value}`).join(", ")}`;
      deps.board.recordBatchAudit({ actor, projectId, count: items.length, reason });
      return ctx.json(ctx.res, 409, {
        error: "BOARD_BATCH_CONFLICT",
        message: reason,
        failures: blocked.map((item) => ({ threadId: item.threadId, code: "BOARD_BATCH_CONFLICT", message: item.reason ?? item.status })),
        items,
        summary,
      });
    }
    const readyLinks = links.filter((link) => items.find((item) => item.threadId === link.threadId)?.status === "ready");
    if (!readyLinks.length) {
      return ctx.json(ctx.res, 200, {
        board: snapshot(who),
        batch: { assigned: 0, alreadyAssigned: summary.alreadyAssigned, total: items.length, version: deps.board.version() },
      });
    }
    try {
      const result = deps.board.batchAssign({ projectId, subprojectId, links: readyLinks, version }, actor);
      return ctx.json(ctx.res, 200, {
        board: snapshot(who),
        batch: { assigned: result.count, alreadyAssigned: summary.alreadyAssigned, total: items.length, version: deps.board.version() },
      });
    } catch (error) {
      if (error instanceof BoardBatchError) {
        return ctx.json(ctx.res, 409, { error: error.code, message: error.message, failures: error.failures, items, summary });
      }
      throw error;
    }
  };

  return async (ctx) => {
    const { res, method, auth } = ctx;
    res.setHeader("cache-control", "no-store");
    const who = viewer(auth);
    if (method === "POST" && (ctx.path === BATCH_PATH || ctx.path === BATCH_PREVIEW_PATH)) {
      try {
        return await handleBatch(ctx, who, ctx.path === BATCH_PREVIEW_PATH);
      } catch (error) {
        if (error instanceof BoardBatchError) return ctx.json(res, 409, { error: error.code, message: error.message, failures: error.failures });
        if (error instanceof BoardError) return fail(ctx, error);
        throw error;
      }
    }
    const match = ROUTE.exec(ctx.path);
    if (!match) return PASS;
    const collection = match[1] as "projects" | "subprojects" | "milestones" | "tasks" | undefined;
    const id = match[2];
    const action = match[3];

    try {
      if (ctx.path === "/api/board/audit" && method === "GET") {
        if (!who.admin) return invalid(ctx, "Only an owner or admin may read the board audit.", "BOARD_FORBIDDEN");
        const raw = Number(ctx.url.searchParams.get("limit") ?? 100);
        if (!Number.isSafeInteger(raw) || raw < 1 || raw > 500) return invalid(ctx, "limit must be between 1 and 500");
        return ctx.json(res, 200, { audit: deps.board.audit(raw), version: deps.board.version() });
      }
      if (!collection && method === "GET") return ctx.json(res, 200, snapshot(who));
      if (!collection) return invalid(ctx, "unsupported request");

      if (method === "POST" && !id) {
        const input = await body(ctx);
        if (!input) return;
        if (collection === "projects") {
          if (!who.admin) return invalid(ctx, "Only an owner or admin may create a project.", "BOARD_FORBIDDEN");
          const extra = unsupported(input, PROJECT_FIELDS);
          if (extra) return invalid(ctx, `unsupported field: ${extra}`);
          const missing = missingText(input, ["owner", "goal", "acceptance"]);
          if (missing) return invalid(ctx, `${missing} is required`);
          deps.board.createProject(input, actorFor(auth));
        } else if (collection === "subprojects") {
          const extra = unsupported(input, SUBPROJECT_FIELDS);
          if (extra) return invalid(ctx, `unsupported field: ${extra}`);
          const missing = missingText(input, ["owner", "deliverable", "acceptance"]);
          if (missing) return invalid(ctx, `${missing} is required`);
          if (!editProjectGuard(ctx, who, typeof input.projectId === "string" ? input.projectId : undefined)) return;
          deps.board.createSubproject(input, actorFor(auth));
        } else if (collection === "milestones") {
          const extra = unsupported(input, MILESTONE_FIELDS);
          if (extra) return invalid(ctx, `unsupported field: ${extra}`);
          if (!editProjectGuard(ctx, who, typeof input.projectId === "string" ? input.projectId : undefined)) return;
          deps.board.createMilestone(input, actorFor(auth));
        } else {
          return invalid(ctx, "create a task with PUT /api/board/tasks/:threadId");
        }
        return ctx.json(res, 201, { board: snapshot(who) });
      }

      if (method === "PATCH" && id && !action) {
        const input = await body(ctx);
        if (!input) return;
        if (collection === "projects") {
          const extra = unsupported(input, PROJECT_FIELDS);
          if (extra) return invalid(ctx, `unsupported field: ${extra}`);
          const emptied = emptiedText(input, ["owner", "goal", "acceptance"]);
          if (emptied) return invalid(ctx, `${emptied} cannot be emptied`);
          if (!editProjectGuard(ctx, who, id)) return;
          deps.board.patchProject(id, input, actorFor(auth));
        } else if (collection === "subprojects") {
          const extra = unsupported(input, SUBPROJECT_FIELDS);
          if (extra) return invalid(ctx, `unsupported field: ${extra}`);
          const emptied = emptiedText(input, ["owner", "deliverable", "acceptance"]);
          if (emptied) return invalid(ctx, `${emptied} cannot be emptied`);
          const subproject = deps.board.state().subprojects.find((candidate) => candidate.id === id);
          if (!subproject) return invalid(ctx, "no such subproject", "BOARD_FORBIDDEN");
          if (!editProjectGuard(ctx, who, subproject.projectId)) return;
          deps.board.patchSubproject(id, input, actorFor(auth));
        } else if (collection === "milestones") {
          const extra = unsupported(input, MILESTONE_PATCH_FIELDS);
          if (extra) return invalid(ctx, `unsupported field: ${extra}`);
          const milestone = deps.board.state().milestones.find((candidate) => candidate.id === id);
          if (!milestone) return invalid(ctx, "no such milestone", "BOARD_FORBIDDEN");
          if (!editProjectGuard(ctx, who, milestone.projectId)) return;
          deps.board.patchMilestone(id, input, actorFor(auth));
        } else {
          return invalid(ctx, "change a task with PUT /api/board/tasks/:threadId");
        }
        return ctx.json(res, 200, { board: snapshot(who) });
      }

      if (collection === "tasks" && id && method === "PUT" && !action) {
        const input = await body(ctx);
        if (!input) return;
        const botId = input.botId;
        if (typeof botId !== "string") return invalid(ctx, "botId is required");
        const existing = deps.board.state().tasks.find((task) => task.threadId === id);
        if (existing) {
          if (!conversationVisible(existing, who)) return invalid(ctx, "no such conversation", "BOARD_FORBIDDEN");
          const project = existing.projectId ? findProject(existing.projectId) : undefined;
          if (project && !projectVisible(project, who)) return invalid(ctx, "no such project", "BOARD_FORBIDDEN");
          if (!taskEditable(existing, project, who)) return invalid(ctx, "Only this task's owner or project owner can change it.", "BOARD_FORBIDDEN");
          if (!project || !projectEditable(project, who)) {
            for (const key of ["projectId", "subprojectId", "parentThreadId"] as const) {
              if (input[key] === undefined) continue;
              const current = existing[key] ?? null;
              if (input[key] !== current) return invalid(ctx, "Only this project's owner can move a task between projects.", "BOARD_FORBIDDEN");
            }
          }
        } else {
          if (!who.visible.thread(id) || !who.visible.bot(botId)) return invalid(ctx, "no such conversation", "BOARD_FORBIDDEN");
          if (typeof input.projectId === "string" && !projectGuard(ctx, who, input.projectId)) return;
        }
        const attached = attachBoardTask(deps, auth, {
          botId, threadId: id, value: input,
          knownThread: deps.threadExists(botId, id),
        });
        if (!attached.ok) return ctx.json(res, attached.status, { error: attached.code, message: attached.message });
        return ctx.json(res, 200, { board: snapshot(who) });
      }

      if (collection === "tasks" && id && method === "POST" && action === "verdict") {
        const input = await body(ctx);
        if (!input) return;
        const extra = unsupported(input, VERDICT_FIELDS);
        if (extra) return invalid(ctx, `unsupported field: ${extra}`);
        const existing = deps.board.state().tasks.find((task) => task.threadId === id);
        if (!existing) return invalid(ctx, "no such board task");
        if (!conversationVisible(existing, who)) return invalid(ctx, "no such conversation", "BOARD_FORBIDDEN");
        const project = existing.projectId ? findProject(existing.projectId) : undefined;
        if (project && !projectVisible(project, who)) return invalid(ctx, "no such project", "BOARD_FORBIDDEN");
        if (!taskEditable(existing, project, who)) return invalid(ctx, "Only this task's owner or project owner can decide it.", "BOARD_FORBIDDEN");
        const task = deps.board.verdict(id, input, actorFor(auth));
        return ctx.json(res, 200, { board: snapshot(who), task });
      }

      if (collection === "tasks" && id && method === "DELETE" && !action) {
        const existing = deps.board.state().tasks.find((task) => task.threadId === id);
        if (!existing) return invalid(ctx, "no such board task");
        if (!conversationVisible(existing, who)) return invalid(ctx, "no such conversation", "BOARD_FORBIDDEN");
        const project = existing.projectId ? findProject(existing.projectId) : undefined;
        if (project && !projectVisible(project, who)) return invalid(ctx, "no such project", "BOARD_FORBIDDEN");
        if (!taskEditable(existing, project, who)) return invalid(ctx, "Only this task's owner or project owner can unclassify it.", "BOARD_FORBIDDEN");
        const raw = ctx.url.searchParams.get("version");
        const removed = deps.board.removeTask(id, { version: raw === null ? undefined : Number(raw) }, actorFor(auth));
        if (!removed) return invalid(ctx, "no such board task");
        return ctx.json(res, 200, { board: snapshot(who) });
      }

      return invalid(ctx, "unsupported request");
    } catch (error) {
      if (error instanceof BoardBatchError) {
        return ctx.json(res, 409, { error: error.code, message: error.message, failures: error.failures });
      }
      if (error instanceof BoardError) return fail(ctx, error);
      throw error;
    }
  };
}
