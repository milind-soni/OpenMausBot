// GET /api/board, and the small writes that keep it current. A board row is metadata about a conversation:
// the transcript itself stays behind the conversation routes.
import { PASS, type RouteHandler } from "./table.ts";
import { attachBoardTask, type BoardAttachDeps } from "../board/attach.ts";
import {
  actorFor, boardViewer, conversationVisible, filterBoard, projectEditable, projectVisible, taskEditable,
  type BoardViewer,
} from "../board/access.ts";
import { BoardError, boardErrorStatus, type BoardStore } from "../board/store.ts";
import type { BoardSnapshot } from "../../shared/board.ts";

export interface BoardRouteDeps extends BoardAttachDeps {
  board: BoardStore;
  /** The conversation exists for this bot; a board row never invents one. */
  threadExists(botId: string, threadId: string): boolean;
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

  return async (ctx) => {
    const match = ROUTE.exec(ctx.path);
    if (!match) return PASS;
    const { res, method, auth } = ctx;
    res.setHeader("cache-control", "no-store");
    const who = viewer(auth);
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
      if (error instanceof BoardError) return fail(ctx, error);
      throw error;
    }
  };
}
