// GET /api/board, and the small writes that keep it current. A board row is metadata about a conversation:
// the transcript itself stays behind the conversation routes.
import { PASS, type RouteHandler } from "./table.ts";
import { attachBoardTask, type BoardAttachDeps } from "../board/attach.ts";
import { BoardError, boardErrorStatus, type BoardStore } from "../board/store.ts";

export interface BoardRouteDeps extends BoardAttachDeps {
  board: BoardStore;
  /** The conversation exists for this bot; a board row never invents one. */
  threadExists(botId: string, threadId: string): boolean;
}

const ROUTE = /^\/api\/board(?:\/(projects|subprojects|milestones|tasks)(?:\/([\w-]+))?(?:\/(verdict))?)?$/;
const LIMIT = 64_000;

const PROJECT_FIELDS = new Set(["name", "description", "version"]);
const SUBPROJECT_FIELDS = new Set(["projectId", "name", "version"]);
const MILESTONE_FIELDS = new Set(["projectId", "subprojectId", "title", "dueAt", "version"]);
const MILESTONE_PATCH_FIELDS = new Set(["title", "status", "verdict", "evidence", "dueAt", "version"]);
const VERDICT_FIELDS = new Set(["decision", "evidence", "version"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function unsupported(body: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  return Object.keys(body).find((key) => !allowed.has(key)) ?? null;
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

  return async (ctx) => {
    const match = ROUTE.exec(ctx.path);
    if (!match) return PASS;
    const { res, method, auth } = ctx;
    res.setHeader("cache-control", "no-store");
    if (!deps.canManage(auth)) return invalid(ctx, "Only an owner or admin may open or change the project board", "BOARD_FORBIDDEN");
    const collection = match[1] as "projects" | "subprojects" | "milestones" | "tasks" | undefined;
    const id = match[2];
    const action = match[3];

    try {
      if (!collection && method === "GET") return ctx.json(res, 200, deps.board.snapshot(true));
      if (!collection) return invalid(ctx, "unsupported request");

      if (method === "POST" && !id) {
        const input = await body(ctx);
        if (!input) return;
        if (collection === "projects") {
          const extra = unsupported(input, PROJECT_FIELDS);
          if (extra) return invalid(ctx, `unsupported field: ${extra}`);
          deps.board.createProject(input);
        } else if (collection === "subprojects") {
          const extra = unsupported(input, SUBPROJECT_FIELDS);
          if (extra) return invalid(ctx, `unsupported field: ${extra}`);
          deps.board.createSubproject(input);
        } else if (collection === "milestones") {
          const extra = unsupported(input, MILESTONE_FIELDS);
          if (extra) return invalid(ctx, `unsupported field: ${extra}`);
          deps.board.createMilestone(input);
        } else {
          return invalid(ctx, "create a task with PUT /api/board/tasks/:threadId");
        }
        return ctx.json(res, 201, { board: deps.board.snapshot(true) });
      }

      if (method === "PATCH" && id && !action) {
        const input = await body(ctx);
        if (!input) return;
        if (collection === "projects") {
          const extra = unsupported(input, PROJECT_FIELDS);
          if (extra) return invalid(ctx, `unsupported field: ${extra}`);
          deps.board.patchProject(id, input);
        } else if (collection === "subprojects") {
          const extra = unsupported(input, new Set(["name", "version"]));
          if (extra) return invalid(ctx, `unsupported field: ${extra}`);
          deps.board.patchSubproject(id, input);
        } else if (collection === "milestones") {
          const extra = unsupported(input, MILESTONE_PATCH_FIELDS);
          if (extra) return invalid(ctx, `unsupported field: ${extra}`);
          deps.board.patchMilestone(id, input);
        } else {
          return invalid(ctx, "change a task with PUT /api/board/tasks/:threadId");
        }
        return ctx.json(res, 200, { board: deps.board.snapshot(true) });
      }

      if (collection === "tasks" && id && method === "PUT" && !action) {
        const input = await body(ctx);
        if (!input) return;
        const botId = input.botId;
        if (typeof botId !== "string") return invalid(ctx, "botId is required");
        const attached = attachBoardTask(deps, auth, {
          botId, threadId: id, value: input,
          knownThread: deps.threadExists(botId, id),
        });
        if (!attached.ok) return ctx.json(res, attached.status, { error: attached.code, message: attached.message });
        return ctx.json(res, 200, { board: deps.board.snapshot(true) });
      }

      if (collection === "tasks" && id && method === "POST" && action === "verdict") {
        const input = await body(ctx);
        if (!input) return;
        const extra = unsupported(input, VERDICT_FIELDS);
        if (extra) return invalid(ctx, `unsupported field: ${extra}`);
        const task = deps.board.verdict(id, input);
        return ctx.json(res, 200, { board: deps.board.snapshot(true), task });
      }

      if (collection === "tasks" && id && method === "DELETE" && !action) {
        const raw = ctx.url.searchParams.get("version");
        const removed = deps.board.removeTask(id, { version: raw === null ? undefined : Number(raw) });
        if (!removed) return invalid(ctx, "no such board task");
        return ctx.json(res, 200, { board: deps.board.snapshot(true) });
      }

      return invalid(ctx, "unsupported request");
    } catch (error) {
      if (error instanceof BoardError) return fail(ctx, error);
      throw error;
    }
  };
}
