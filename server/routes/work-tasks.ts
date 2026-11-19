import type { ServerResponse } from "node:http";
import {
  computeRoomTaskOverview,
  isQaBot,
  type AgentTask,
  type AgentTaskEvidenceType,
  type AgentTaskPriority,
  type AgentTaskStatus,
  type AgentTaskType,
  type TaskActivityType,
} from "../../shared/work-tasks.ts";
import { chiefLevel } from "../chief-level.ts";
import type { json as sendJson } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, GroupRecord } from "../store.ts";
import type { JiraSyncService } from "../work-tasks-jira.ts";
import { WorkTaskError, type WorkTaskActor, type WorkTaskStore } from "../work-tasks.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export interface WorkTaskRouteDeps {
  tasks: WorkTaskStore;
  jira: JiraSyncService;
  group: (id: string) => GroupRecord | undefined;
  groups: () => readonly GroupRecord[];
  groupByThread: (threadId: string) => GroupRecord | undefined;
  bot: (id: string) => BotRecord | undefined;
  visible: (auth: RequestAuth) => { everything: boolean; group: (id: string) => boolean; bot: (id: string) => boolean };
  actorName: (auth: RequestAuth) => string;
}

function isRoomCoordinatorBot(
  bot: BotRecord,
  room: GroupRecord | undefined,
  task?: Pick<AgentTask, "coordinatorBotId"> | null,
): boolean {
  if (task?.coordinatorBotId && task.coordinatorBotId === bot.id) return true;
  if (chiefLevel(bot)) return true;
  if (room && room.defaultResponder.kind === "member" && room.defaultResponder.botId === bot.id) return true;
  return false;
}

function defaultCoordinatorForRoom(room: GroupRecord | undefined, botLookup: (id: string) => BotRecord | undefined): string | undefined {
  if (!room) return undefined;
  if (room.defaultResponder.kind === "member" && room.defaultResponder.botId) {
    return room.defaultResponder.botId;
  }
  for (const id of room.memberIds) {
    const member = botLookup(id);
    if (member && chiefLevel(member)) return member.id;
  }
  return room.memberIds[0];
}

function maybeTriggerJiraAutoSync(
  tasks: WorkTaskStore,
  jira: JiraSyncService,
  task: AgentTask | undefined,
  comment?: { message: string; actor: { name?: string; role?: string; type?: string } },
): void {
  if (!task?.jiraSync?.issueKey) return;
  const cfg = tasks.getRoomJiraConfig(task.roomId);
  if (!cfg.enabled || !cfg.autoSync) return;
  void jira.syncTaskToJira(task.id, comment?.message, comment?.actor).catch(() => {});
}

export function createWorkTaskRoutes(deps: WorkTaskRouteDeps): RouteHandler {
  const { tasks, jira, group, groups, bot, visible, actorName } = deps;

  return async ({ req, res, url, path, method, auth, json, readBody }: RouteContext) => {
    if (!path.startsWith("/api/work-tasks")) return PASS;
    const seen = visible(auth);
    const userActor: WorkTaskActor = {
      actorType: "user",
      actorId: auth.kind === "session" ? auth.session.id : "owner",
      actorName: actorName(auth),
    };

    try {
      // Jira inbound webhook receiver (public/token-optional or signed endpoint)
      if (path === "/api/work-tasks/jira/webhook" && method === "POST") {
        const body = await readBody(req);
        const result = jira.handleWebhook(body);
        return json(res, 200, result);
      }

      // Telegram Bridge Control Plane
      if (path === "/api/work-tasks/telegram/query" && method === "GET") {
        const cmd = url.searchParams.get("cmd") ?? "/status";
        const roomId = url.searchParams.get("roomId") ?? undefined;
        if (roomId && !seen.group(roomId)) return json(res, 404, { error: "no such room" });
        const visibleRooms = groups()
          .filter((g) => !g.dm && seen.group(g.id))
          .map((g) => ({ id: g.id, name: g.name }));
        return json(res, 200, tasks.formatTelegramCommand(cmd, visibleRooms, roomId));
      }

      if (path === "/api/work-tasks/telegram/command" && method === "POST") {
        const body = (await readBody(req)) as { command?: unknown; text?: unknown; roomId?: unknown } | null;
        const cmd = typeof body?.command === "string" ? body.command : typeof body?.text === "string" ? body.text : "/status";
        const roomId = typeof body?.roomId === "string" && body.roomId ? body.roomId : undefined;
        if (roomId && !seen.group(roomId)) return json(res, 404, { error: "no such room" });
        const visibleRooms = groups()
          .filter((g) => !g.dm && seen.group(g.id))
          .map((g) => ({ id: g.id, name: g.name }));
        return json(res, 200, tasks.formatTelegramCommand(cmd, visibleRooms, roomId));
      }

      // Per-room Jira config
      const jiraMatch = path.match(/^\/api\/work-tasks\/rooms\/([\w-]+)\/jira$/);
      if (jiraMatch) {
        const roomId = jiraMatch[1]!;
        if (!group(roomId) || !seen.group(roomId)) return json(res, 404, { error: "no such room" });
        if (method === "GET") {
          return json(res, 200, { config: tasks.getRoomJiraConfig(roomId) });
        }
        if (method === "PUT") {
          const body = (await readBody(req)) as Record<string, unknown> | null;
          if (!body || typeof body !== "object") return json(res, 400, { error: "Expected JSON body" });
          const saved = tasks.saveRoomJiraConfig(roomId, {
            ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
            ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
            ...(typeof body.email === "string" ? { email: body.email } : {}),
            ...(typeof body.projectKey === "string" ? { projectKey: body.projectKey } : {}),
            ...(typeof body.issueType === "string" ? { issueType: body.issueType } : {}),
            ...(typeof body.assigneeCustomFieldId === "string" ? { assigneeCustomFieldId: body.assigneeCustomFieldId } : {}),
            ...(body.statusMap && typeof body.statusMap === "object" && !Array.isArray(body.statusMap)
              ? { statusMap: body.statusMap as Partial<Record<AgentTaskStatus, string>> }
              : {}),
            ...(typeof body.autoSync === "boolean" ? { autoSync: body.autoSync } : {}),
            ...(body.apiToken === null || typeof body.apiToken === "string" ? { apiToken: body.apiToken } : {}),
          });
          return json(res, 200, { config: saved });
        }
      }

      // Collection routes
      if (path === "/api/work-tasks" && method === "GET") {
        const roomId = url.searchParams.get("roomId") ?? undefined;
        if (roomId && (!group(roomId) || !seen.group(roomId))) {
          return json(res, 404, { error: "no such room" });
        }
        const statusParam = url.searchParams.get("status") as AgentTaskStatus | null;
        const typeParam = url.searchParams.get("type") as AgentTaskType | null;
        const priorityParam = url.searchParams.get("priority") as AgentTaskPriority | null;
        const list = tasks
          .list({
            ...(roomId ? { roomId } : {}),
            ...(url.searchParams.get("assigneeBotId") ? { assigneeBotId: url.searchParams.get("assigneeBotId")! } : {}),
            ...(url.searchParams.get("assigneeRole") ? { assigneeRole: url.searchParams.get("assigneeRole")! } : {}),
            ...(statusParam ? { status: statusParam } : {}),
            ...(typeParam ? { type: typeParam } : {}),
            ...(priorityParam ? { priority: priorityParam } : {}),
            ...(url.searchParams.get("parentTaskId") ? { parentTaskId: url.searchParams.get("parentTaskId")! } : {}),
            ...(url.searchParams.get("q") ? { q: url.searchParams.get("q")! } : {}),
            ...(url.searchParams.get("needsUserAction") === "true" ? { needsUserAction: true } : {}),
            ...(url.searchParams.get("overdue") === "true" ? { overdue: true } : {}),
          })
          .filter((t) => seen.group(t.roomId));

        let overview = undefined;
        if (roomId) {
          const room = group(roomId)!;
          const allRoomTasks = tasks.list({ roomId });
          const members = room.memberIds
            .map((id) => bot(id))
            .filter((b): b is BotRecord => Boolean(b))
            .map((b) => ({
              id: b.id,
              name: b.name,
              ...(b.title ? { title: b.title } : {}),
              busy: Boolean(b.busy),
            }));
          overview = computeRoomTaskOverview(allRoomTasks, members);
        }
        return json(res, 200, { tasks: list, ...(overview ? { overview } : {}) });
      }

      if (path === "/api/work-tasks" && method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return json(res, 400, { error: "Expected JSON body" });
        const roomId = typeof body.roomId === "string" ? body.roomId : "";
        const room = group(roomId);
        if (!room || !seen.group(roomId)) return json(res, 404, { error: "no such room" });

        const assigneeId = typeof body.assigneeBotId === "string" && body.assigneeBotId ? body.assigneeBotId : undefined;
        const assigneeBot = assigneeId ? bot(assigneeId) : undefined;
        const coordinatorBotId =
          typeof body.coordinatorBotId === "string" && body.coordinatorBotId
            ? body.coordinatorBotId
            : defaultCoordinatorForRoom(room, bot);

        const created = tasks.create(
          {
            roomId,
            ...(typeof body.parentTaskId === "string" && body.parentTaskId ? { parentTaskId: body.parentTaskId } : {}),
            ...(typeof body.type === "string" ? { type: body.type as AgentTaskType } : {}),
            title: String(body.title ?? ""),
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(typeof body.status === "string" ? { status: body.status as AgentTaskStatus } : {}),
            ...(typeof body.priority === "string" ? { priority: body.priority as AgentTaskPriority } : {}),
            ...(coordinatorBotId ? { coordinatorBotId } : {}),
            ...(assigneeId ? { assigneeBotId: assigneeId } : {}),
            assigneeName: typeof body.assigneeName === "string" ? body.assigneeName : assigneeBot?.name,
            assigneeRole: typeof body.assigneeRole === "string" ? body.assigneeRole : assigneeBot?.title,
            ...(typeof body.qaBotId === "string" && body.qaBotId ? { qaBotId: body.qaBotId } : {}),
            ...(Array.isArray(body.acceptanceCriteria) ? { acceptanceCriteria: body.acceptanceCriteria.map(String) } : {}),
            ...(Array.isArray(body.labels) ? { labels: body.labels.map(String) } : {}),
            ...(typeof body.dueAt === "number" ? { dueAt: body.dueAt } : {}),
            ...(typeof body.estimate === "number" ? { estimate: body.estimate } : {}),
            ...(typeof body.threadId === "string" ? { threadId: body.threadId } : {}),
            ...(typeof body.assignmentId === "string" ? { assignmentId: body.assignmentId } : {}),
            ...(Array.isArray(body.dependencies) ? { dependencies: body.dependencies.map(String) } : {}),
            ...(Array.isArray(body.blockedBy) ? { blockedBy: body.blockedBy.map(String) } : {}),
          },
          userActor,
        );
        return json(res, 201, created);
      }

      // Single task routes
      const taskMatch = path.match(/^\/api\/work-tasks\/([\w-]+)(?:\/(comments|evidence|jira\/create|jira\/link|jira\/sync))?$/);
      if (!taskMatch) return PASS;
      const idOrKey = taskMatch[1]!;
      const sub = taskMatch[2];
      const existing = tasks.get(idOrKey);
      if (!existing || !seen.group(existing.roomId)) {
        return json(res, 404, { error: "Task not found" });
      }

      if (!sub && method === "GET") {
        return json(res, 200, {
          task: existing,
          subtasks: tasks.subtasks(existing.id),
          activities: tasks.activities(existing.id),
        });
      }

      if (!sub && method === "PATCH") {
        const body = (await readBody(req)) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return json(res, 400, { error: "Expected JSON body" });
        const nextAssigneeId = body.assigneeBotId === null
          ? null
          : typeof body.assigneeBotId === "string"
            ? body.assigneeBotId
            : undefined;
        const nextBot = typeof nextAssigneeId === "string" ? bot(nextAssigneeId) : undefined;
        const updated = tasks.update(
          existing.id,
          {
            ...(typeof body.title === "string" ? { title: body.title } : {}),
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(typeof body.type === "string" ? { type: body.type as AgentTaskType } : {}),
            ...(typeof body.status === "string" ? { status: body.status as AgentTaskStatus } : {}),
            ...(typeof body.statusNote === "string" ? { statusNote: body.statusNote } : {}),
            ...(typeof body.priority === "string" ? { priority: body.priority as AgentTaskPriority } : {}),
            ...(body.parentTaskId === null || typeof body.parentTaskId === "string"
              ? { parentTaskId: body.parentTaskId }
              : {}),
            ...(body.coordinatorBotId === null || typeof body.coordinatorBotId === "string"
              ? { coordinatorBotId: body.coordinatorBotId }
              : {}),
            ...(nextAssigneeId !== undefined
              ? {
                  assigneeBotId: nextAssigneeId,
                  assigneeName: typeof body.assigneeName === "string" ? body.assigneeName : nextBot?.name ?? null,
                  assigneeRole: typeof body.assigneeRole === "string" ? body.assigneeRole : nextBot?.title ?? null,
                }
              : {}),
            ...(body.qaBotId === null || typeof body.qaBotId === "string" ? { qaBotId: body.qaBotId } : {}),
            ...(Array.isArray(body.acceptanceCriteria) ? { acceptanceCriteria: body.acceptanceCriteria.map(String) } : {}),
            ...(Array.isArray(body.labels) ? { labels: body.labels.map(String) } : {}),
            ...(body.dueAt === null || typeof body.dueAt === "number" ? { dueAt: body.dueAt } : {}),
            ...(body.estimate === null || typeof body.estimate === "number" ? { estimate: body.estimate } : {}),
            ...(Array.isArray(body.dependencies) ? { dependencies: body.dependencies.map(String) } : {}),
            ...(Array.isArray(body.blockedBy) ? { blockedBy: body.blockedBy.map(String) } : {}),
            ...(typeof body.needsUserAction === "boolean" ? { needsUserAction: body.needsUserAction } : {}),
            ...(body.needsUserReason === null || typeof body.needsUserReason === "string"
              ? { needsUserReason: body.needsUserReason }
              : {}),
          },
          userActor,
        );
        maybeTriggerJiraAutoSync(tasks, jira, updated);
        return json(res, 200, { task: updated });
      }

      if (!sub && method === "DELETE") {
        tasks.delete(existing.id, userActor);
        return json(res, 200, { ok: true });
      }

      if (sub === "comments" && method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown> | null;
        const message = typeof body?.message === "string" ? body.message : "";
        const type = typeof body?.type === "string" ? (body.type as TaskActivityType) : "comment";
        const updated = tasks.addActivity(existing.id, { type, message }, userActor);
        maybeTriggerJiraAutoSync(tasks, jira, updated, {
          message,
          actor: { name: userActor.actorName, type: "user" },
        });
        return json(res, 201, { task: updated, activities: tasks.activities(existing.id) });
      }

      if (sub === "evidence" && method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown> | null;
        const type = typeof body?.type === "string" ? (body.type as AgentTaskEvidenceType) : "message";
        const label = typeof body?.label === "string" ? body.label : "";
        const value = typeof body?.value === "string" ? body.value : "";
        const updated = tasks.addEvidence(existing.id, { type, label, value }, userActor);
        return json(res, 201, { task: updated, activities: tasks.activities(existing.id) });
      }

      if (sub === "jira/create" && method === "POST") {
        const out = await jira.createIssueForTask(existing.id);
        return json(res, out.ok ? 201 : 502, out);
      }

      if (sub === "jira/link" && method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown> | null;
        const issueKey = typeof body?.issueKey === "string" ? body.issueKey : "";
        const out = await jira.linkIssue(existing.id, issueKey);
        return json(res, out.ok ? 200 : 400, out);
      }

      if (sub === "jira/sync" && method === "POST") {
        const out = await jira.syncTaskToJira(existing.id);
        return json(res, out.ok ? 200 : 502, out);
      }

      return PASS;
    } catch (error) {
      if (error instanceof WorkTaskError) {
        return json(res, error.status, { error: error.message });
      }
      throw error;
    }
  };
}

export interface InternalWorkTaskContext {
  method: string;
  path: string;
  url: URL;
  res: ServerResponse;
  json: typeof sendJson;
  bot: BotRecord;
  threadId: string;
  readBody: () => Promise<unknown>;
  tasks: WorkTaskStore;
  jira: JiraSyncService;
  group: (id: string) => GroupRecord | undefined;
  groupByThread: (threadId: string) => GroupRecord | undefined;
  groups: () => readonly GroupRecord[];
  botLookup: (id: string) => BotRecord | undefined;
}

/**
 * Internal agent endpoints (`/api/internal/work-tasks*`).
 * Security invariant: Actor identity (`actorId`, `actorName`, `actorRole`) is ALWAYS resolved from
 * the authenticated `internalCapability` (`ctx.bot`, `ctx.threadId`), never from body parameters.
 */
export async function handleInternalWorkTaskRoute(ctx: InternalWorkTaskContext): Promise<typeof PASS | void> {
  const { method, path, url, res, json, bot, threadId, readBody, tasks, jira, group, groupByThread, groups, botLookup } = ctx;
  if (!path.startsWith("/api/internal/work-tasks")) return PASS;

  const sourceRoom = groupByThread(threadId);
  const memberRooms = groups().filter((g) => !g.dm && g.memberIds.includes(bot.id));

  const resolveActorFor = (room: GroupRecord | undefined, task?: AgentTask | null): WorkTaskActor => {
    const isCoordinator = isRoomCoordinatorBot(bot, room, task);
    const isQa = isQaBot(bot, task);
    const actorRole = bot.title?.trim() || (isCoordinator ? "Coordinator" : isQa ? "QA" : "Worker");
    return {
      actorType: "agent",
      actorId: bot.id,
      actorName: bot.name,
      actorRole,
      isCoordinator,
      isQa,
    };
  };

  try {
    if (path === "/api/internal/work-tasks" && method === "GET") {
      const requestedRoomId = url.searchParams.get("roomId") ?? sourceRoom?.id;
      const room = requestedRoomId ? group(requestedRoomId) : undefined;
      if (requestedRoomId && (!room || (!room.memberIds.includes(bot.id) && !chiefLevel(bot)))) {
        return json(res, 403, { error: "You can only inspect work tasks in rooms you belong to." });
      }
      const allowedRoomIds = new Set(memberRooms.map((r) => r.id));
      const status = url.searchParams.get("status") as AgentTaskStatus | null;
      const assigneeBotId = url.searchParams.get("assigneeBotId") ?? undefined;
      const list = tasks
        .list({
          ...(requestedRoomId ? { roomId: requestedRoomId } : {}),
          ...(status ? { status } : {}),
          ...(assigneeBotId ? { assigneeBotId } : {}),
        })
        .filter((t) => chiefLevel(bot) || allowedRoomIds.has(t.roomId) || t.assigneeBotId === bot.id);
      return json(res, 200, { tasks: list });
    }

    if (path === "/api/internal/work-tasks" && method === "POST") {
      const body = (await readBody()) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return json(res, 400, { error: "Expected JSON body" });
      const roomId = typeof body.roomId === "string" && body.roomId ? body.roomId : sourceRoom?.id ?? memberRooms[0]?.id ?? "";
      const room = group(roomId);
      if (!room) return json(res, 400, { error: "roomId is required when creating a task outside a room." });
      if (!room.memberIds.includes(bot.id) && !chiefLevel(bot)) {
        return json(res, 403, { error: "You are not a member of that room." });
      }

      const assigneeId = typeof body.assigneeBotId === "string" && body.assigneeBotId ? body.assigneeBotId : undefined;
      const assigneeBot = assigneeId ? botLookup(assigneeId) : undefined;
      if (assigneeId && !assigneeBot) return json(res, 400, { error: `Unknown assignee bot "${assigneeId}".` });

      const actor = resolveActorFor(room, null);
      const created = tasks.create(
        {
          roomId: room.id,
          ...(typeof body.parentTaskId === "string" && body.parentTaskId ? { parentTaskId: body.parentTaskId } : {}),
          ...(typeof body.type === "string" ? { type: body.type as AgentTaskType } : {}),
          title: String(body.title ?? ""),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.priority === "string" ? { priority: body.priority as AgentTaskPriority } : {}),
          coordinatorBotId: isRoomCoordinatorBot(bot, room) ? bot.id : defaultCoordinatorForRoom(room, botLookup),
          ...(assigneeId ? { assigneeBotId: assigneeId } : {}),
          ...(assigneeBot ? { assigneeName: assigneeBot.name, assigneeRole: typeof body.assigneeRole === "string" ? body.assigneeRole : assigneeBot.title } : {}),
          ...(typeof body.qaBotId === "string" ? { qaBotId: body.qaBotId } : {}),
          ...(Array.isArray(body.acceptanceCriteria) ? { acceptanceCriteria: body.acceptanceCriteria.map(String) } : {}),
          ...(Array.isArray(body.labels) ? { labels: body.labels.map(String) } : {}),
          ...(typeof body.dueAt === "number" ? { dueAt: body.dueAt } : {}),
          ...(Array.isArray(body.dependencies) ? { dependencies: body.dependencies.map(String) } : {}),
        },
        actor,
      );
      return json(res, 201, created);
    }

    const detailMatch = path.match(/^\/api\/internal\/work-tasks\/([\w-]+)$/);
    if (detailMatch && method === "GET") {
      const task = tasks.get(detailMatch[1]!);
      if (!task) return json(res, 404, { error: "Task not found" });
      const room = group(task.roomId);
      if (!chiefLevel(bot) && task.assigneeBotId !== bot.id && !room?.memberIds.includes(bot.id)) {
        return json(res, 403, { error: "Access denied for this task." });
      }
      return json(res, 200, {
        task,
        subtasks: tasks.subtasks(task.id),
        activities: tasks.activities(task.id),
      });
    }

    if (detailMatch && method === "PATCH") {
      const task = tasks.get(detailMatch[1]!);
      if (!task) return json(res, 404, { error: "Task not found" });
      const room = group(task.roomId);
      if (!chiefLevel(bot) && task.assigneeBotId !== bot.id && !room?.memberIds.includes(bot.id)) {
        return json(res, 403, { error: "Access denied for this task." });
      }
      const actor = resolveActorFor(room, task);
      const body = (await readBody()) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return json(res, 400, { error: "Expected JSON body" });

      let latest = task;

      if (typeof body.assigneeBotId === "string" && body.assigneeBotId && body.assigneeBotId !== latest.assigneeBotId) {
        const nextAssignee = botLookup(body.assigneeBotId);
        if (!nextAssignee) return json(res, 400, { error: `Unknown assignee bot "${body.assigneeBotId}".` });
        latest = tasks.assign(
          latest.id,
          {
            assigneeBotId: nextAssignee.id,
            assigneeName: nextAssignee.name,
            assigneeRole: typeof body.assigneeRole === "string" ? body.assigneeRole : nextAssignee.title,
          },
          actor,
        );
      }

      if (typeof body.status === "string" && body.status !== latest.status) {
        const nextStatus = body.status as AgentTaskStatus;
        if ((nextStatus === "in-review" || nextStatus === "done") && tasks.hasUnfinishedSubtasks(latest.id)) {
          return json(res, 409, {
            error: "Cannot move task to review/done while child subtasks are still in progress.",
          });
        }
        latest = tasks.transition(latest.id, nextStatus, actor, {
          message: typeof body.statusNote === "string" ? body.statusNote : typeof body.comment === "string" ? body.comment : undefined,
        });
        maybeTriggerJiraAutoSync(tasks, jira, latest);
      }

      if (typeof body.progress === "string" && body.progress.trim()) {
        latest = tasks.addActivity(latest.id, { type: "progress", message: body.progress }, actor);
      }

      if (typeof body.comment === "string" && body.comment.trim() && body.status === undefined) {
        latest = tasks.addActivity(latest.id, { type: "comment", message: body.comment }, actor);
        maybeTriggerJiraAutoSync(tasks, jira, latest, {
          message: body.comment,
          actor: { name: actor.actorName, role: actor.actorRole, type: "agent" },
        });
      }

      if (body.evidence && typeof body.evidence === "object") {
        const ev = body.evidence as Record<string, unknown>;
        latest = tasks.addEvidence(
          latest.id,
          {
            type: (typeof ev.type === "string" ? ev.type : "message") as AgentTaskEvidenceType,
            label: String(ev.label ?? "Evidence"),
            value: String(ev.value ?? ""),
          },
          actor,
        );
      }

      return json(res, 200, { task: latest, activities: tasks.activities(latest.id) });
    }

    return PASS;
  } catch (error) {
    if (error instanceof WorkTaskError) {
      return json(res, error.status, { error: error.message });
    }
    throw error;
  }
}

