// The task list for the app (docs/bot-tasks.md). Admin sessions only: request-auth.ts does not list these paths for members.
//   GET  /api/bot-tasks             { enabled, tasks } newest first; ?status=&bot=&repo=&q=
//   GET  /api/bot-tasks/:id         { task, ownerName }
// PATCH  /api/bot-tasks/:id         { status, evidence?, comment? } updates one task
//   POST /api/bot-tasks/:id/sync    { ok, task } polls the linked pull request or issue now, even when polling is off
//   POST /api/bot-tasks/:id/post    { ok, url, task } the person's own comment on GitHub, with merge: true to merge first
import { z } from "zod";

import { BOT_TASK_LIMITS, BOT_TASK_STATUSES, REPO_PATTERN, type BotTaskActor } from "../../shared/bot-tasks.ts";
import { BotTaskError } from "../bot-tasks/evidence.ts";
import type { BotTasks } from "../bot-tasks/service.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const BOT_TASKS_PATH = "/api/bot-tasks";

export interface BotTasksRouteDeps {
  tasks: Pick<BotTasks, "list" | "get" | "setStatus" | "sync" | "linkGithub" | "prepareMerge" | "post">;
  enabled(): boolean;
  person(auth: RequestAuth): string;
}

const statusSchema = z.object({
  status: z.enum(BOT_TASK_STATUSES),
  evidence: z.array(z.unknown()).max(BOT_TASK_LIMITS.evidencePerMove).optional(),
  comment: z.string().max(BOT_TASK_LIMITS.textMax).optional(),
}).strict();

const refSchema = z.object({ repo: z.string().regex(REPO_PATTERN), number: z.number().int().positive() }).strict();
const postSchema = z.object({
  text: z.string().max(BOT_TASK_LIMITS.textMax),
  expectedRef: refSchema,
  merge: z.boolean().optional(),
  sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
}).strict().refine((body) => Boolean(body.merge) === Boolean(body.sha));

export function createBotTasksRoutes(deps: BotTasksRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    if (path !== BOT_TASKS_PATH && !path.startsWith(`${BOT_TASKS_PATH}/`)) return PASS;
    try {
      if (path === BOT_TASKS_PATH) {
        if (method !== "GET") return json(res, 405, { error: "Use GET." });
        if (!deps.enabled()) return json(res, 200, { enabled: false, tasks: [] });
        const status = url.searchParams.get("status") ?? "";
        if (status && !(BOT_TASK_STATUSES as readonly string[]).includes(status)) return json(res, 400, { error: `status is one of ${BOT_TASK_STATUSES.join(", ")}.` });
        const bot = url.searchParams.get("bot"), repo = url.searchParams.get("repo"), query = url.searchParams.get("q");
        return json(res, 200, {
          enabled: true,
          tasks: deps.tasks.list({ ...(status ? { status: status as (typeof BOT_TASK_STATUSES)[number] } : {}), ...(bot ? { botId: bot } : {}), ...(repo ? { repo } : {}), ...(query ? { query } : {}), limit: BOT_TASK_LIMITS.tasksMax }),
        });
      }
      if (!deps.enabled()) return json(res, 404, { error: "Bot tasks are off. Turn them on in Settings → Bot tasks." });
      const [, , , rawId, action, ...rest] = path.split("/");
      if (!rawId || rest.length) return json(res, 404, { error: "not found" });
      const id = decodeURIComponent(rawId);
      if (!action) {
        if (method === "PATCH") {
          const parsed = statusSchema.safeParse(await readBody(req, 64_000).catch(() => null));
          if (!parsed.success) return json(res, 400, { error: "Send a status, optional evidence and an optional comment." });
          const task = await deps.tasks.setStatus(id, { ...parsed.data, by: { kind: "person", name: deps.person(auth) } });
          return json(res, 200, { ok: true, task });
        }
        if (method !== "GET") return json(res, 405, { error: "Use GET or PATCH." });
        const { ownerName, ...task } = deps.tasks.get(id);
        return json(res, 200, { task, ownerName });
      }
      if ((action === "post" || action === "merge-head" || action === "link") && !ownerOrAdmin(auth)) {
        return json(res, 403, { error: "Only an administrator can use this GitHub action." });
      }
      if (action === "merge-head") {
        if (method !== "GET") return json(res, 405, { error: "Use GET." });
        const ref = refSchema.safeParse({ repo: url.searchParams.get("repo"), number: Number(url.searchParams.get("number")) });
        if (!ref.success) return json(res, 400, { error: "Send a GitHub repository and pull request number." });
        return json(res, 200, await deps.tasks.prepareMerge(id, ref.data));
      }
      if (method !== "POST") return json(res, 405, { error: "Use POST." });
      if (action === "sync") {
        const { task } = await deps.tasks.sync(id, { force: true });
        return json(res, 200, { ok: true, task });
      }
      if (action === "link") {
        const parsed = z.object({ ref: z.string().max(300) }).strict().safeParse(await readBody(req, 16_000).catch(() => null));
        if (!parsed.success) return json(res, 400, { error: "Send a GitHub reference." });
        const task = deps.tasks.linkGithub(id, parsed.data.ref, { kind: "person", name: deps.person(auth) });
        return json(res, 200, { ok: true, task });
      }
      if (action === "post") {
        const parsed = postSchema.safeParse(await readBody(req, 16_000).catch(() => null));
        if (!parsed.success) return json(res, 400, { error: "Send text and the displayed GitHub link. To merge, include the confirmed head SHA." });
        const by: Extract<BotTaskActor, { kind: "person" }> = { kind: "person", name: deps.person(auth) };
        const result = await deps.tasks.post(id, { text: parsed.data.text, expectedRef: parsed.data.expectedRef, mergeHead: parsed.data.sha, by });
        return json(res, 200, { ok: true, url: result.url, task: result.task });
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof BotTaskError) return json(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      throw error;
    }
  };
}
