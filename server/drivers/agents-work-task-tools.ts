import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const WORK_TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "work_task_list",
  "work_task_get",
  "work_task_create",
  "work_task_update",
]);

export async function callWorkTaskTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { apiResponse } = context.client;
  if (name === "work_task_list") {
    const query = new URLSearchParams();
    if (typeof args.room_id === "string" && args.room_id.trim()) query.set("roomId", args.room_id.trim());
    if (typeof args.status === "string" && args.status.trim()) query.set("status", args.status.trim());
    if (typeof args.assignee_bot_id === "string" && args.assignee_bot_id.trim()) {
      query.set("assigneeBotId", args.assignee_bot_id.trim());
    }
    const { ok, body } = await apiResponse(`/api/internal/work-tasks${query.size ? `?${query.toString()}` : ""}`);
    if (!ok) return { text: String(body.error ?? "Failed to list work tasks."), isError: true };
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    if (!tasks.length) return { text: "No work tasks found matching the filters." };
    const lines = tasks.map((t: any) => {
      const who = t.assigneeName ? `${t.assigneeName}${t.assigneeRole ? ` (${t.assigneeRole})` : ""}` : "Unassigned";
      return `- ${t.key} [${t.status}] (${t.type}/${t.priority}) ${t.title} → ${who}${t.threadId ? ` [thread: ${t.threadId}]` : ""}`;
    });
    return { text: `Work tasks (${tasks.length}):\n${lines.join("\n")}` };
  }

  if (name === "work_task_get") {
    const id = typeof args.task_id === "string" ? args.task_id.trim() : "";
    if (!id) return { text: "work_task_get requires task_id (key like LOOMA-101 or id).", isError: true };
    const { ok, body } = await apiResponse(`/api/internal/work-tasks/${encodeURIComponent(id)}`);
    if (!ok) return { text: String(body.error ?? `Failed to get task ${id}.`), isError: true };
    return { text: JSON.stringify(body) };
  }

  if (name === "work_task_create") {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) return { text: "work_task_create requires title.", isError: true };
    const { ok, body } = await apiResponse("/api/internal/work-tasks", {
      method: "POST",
      body: JSON.stringify({
        title,
        ...(typeof args.room_id === "string" && args.room_id.trim() ? { roomId: args.room_id.trim() } : {}),
        ...(typeof args.description === "string" ? { description: args.description } : {}),
        ...(typeof args.type === "string" ? { type: args.type } : {}),
        ...(typeof args.priority === "string" ? { priority: args.priority } : {}),
        ...(typeof args.parent_task_id === "string" && args.parent_task_id.trim()
          ? { parentTaskId: args.parent_task_id.trim() }
          : {}),
        ...(typeof args.assignee_bot_id === "string" && args.assignee_bot_id.trim()
          ? { assigneeBotId: args.assignee_bot_id.trim() }
          : {}),
        ...(typeof args.qa_bot_id === "string" && args.qa_bot_id.trim() ? { qaBotId: args.qa_bot_id.trim() } : {}),
        ...(Array.isArray(args.acceptance_criteria) ? { acceptanceCriteria: args.acceptance_criteria } : {}),
        ...(Array.isArray(args.labels) ? { labels: args.labels } : {}),
      }),
    });
    if (!ok) return { text: String(body.error ?? "Failed to create work task."), isError: true };
    const t = body.task as any;
    return { text: `Created ${t?.key ?? "task"} (id: ${t?.id}): ${t?.title} [${t?.status}]` };
  }

  if (name === "work_task_update") {
    const id = typeof args.task_id === "string" ? args.task_id.trim() : "";
    if (!id) return { text: "work_task_update requires task_id (key like LOOMA-101 or id).", isError: true };
    const evidence =
      typeof args.evidence_label === "string" && typeof args.evidence_value === "string"
        ? {
            type: typeof args.evidence_type === "string" ? args.evidence_type : "message",
            label: args.evidence_label,
            value: args.evidence_value,
          }
        : undefined;
    const { ok, body } = await apiResponse(`/api/internal/work-tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...(typeof args.status === "string" ? { status: args.status } : {}),
        ...(typeof args.status_note === "string" ? { statusNote: args.status_note } : {}),
        ...(typeof args.comment === "string" ? { comment: args.comment } : {}),
        ...(typeof args.progress === "string" ? { progress: args.progress } : {}),
        ...(typeof args.assignee_bot_id === "string" && args.assignee_bot_id.trim()
          ? { assigneeBotId: args.assignee_bot_id.trim() }
          : {}),
        ...(evidence ? { evidence } : {}),
      }),
    });
    if (!ok) return { text: String(body.error ?? `Failed to update task ${id}.`), isError: true };
    const t = body.task as any;
    return { text: `Updated ${t?.key ?? id}: status=${t?.status}${t?.assigneeName ? `, assignee=${t.assigneeName}` : ""}` };
  }

  return { text: `Unknown work task tool: ${name}`, isError: true };
}

export const WORK_TASK_TOOL_DEFINITIONS = [
  {
    name: "work_task_list",
    description: "Read-only: list LOOMA work tasks (epics, tasks, subtasks, bugs) in the room or filtered by status/assignee.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        room_id: { type: "string" },
        status: { type: "string", enum: ["backlog", "todo", "in-progress", "blocked", "in-review", "rework", "done", "failed", "cancelled"] },
        assignee_bot_id: { type: "string" },
      },
    },
  },
  {
    name: "work_task_get",
    description: "Read-only: get full work task detail, subtasks, evidence and activity history by task id or key (e.g. LOOMA-101).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: { type: "string", minLength: 1 },
      },
      required: ["task_id"],
    },
  },
  {
    name: "work_task_create",
    description: "Create a work task or subtask in LOOMA Work Management and optionally assign a teammate.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 280 },
        description: { type: "string", maxLength: 8000 },
        type: { type: "string", enum: ["epic", "task", "subtask", "bug"] },
        priority: { type: "string", enum: ["lowest", "low", "medium", "high", "highest"] },
        parent_task_id: { type: "string" },
        assignee_bot_id: { type: "string" },
        qa_bot_id: { type: "string" },
        room_id: { type: "string" },
        acceptance_criteria: { type: "array", maxItems: 20, items: { type: "string" } },
        labels: { type: "array", maxItems: 12, items: { type: "string" } },
      },
      required: ["title"],
    },
  },
  {
    name: "work_task_update",
    description: "Update task status (respecting workflow: workers move to in-progress/blocked/in-review only; QA/Coordinator move in-review to done or rework), log progress/comment, or attach evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: { type: "string", minLength: 1 },
        status: { type: "string", enum: ["backlog", "todo", "in-progress", "blocked", "in-review", "rework", "done", "failed", "cancelled"] },
        status_note: { type: "string", maxLength: 1000 },
        progress: { type: "string", maxLength: 2000 },
        comment: { type: "string", maxLength: 2000 },
        assignee_bot_id: { type: "string" },
        evidence_type: { type: "string", enum: ["file", "commit", "test", "url", "message"] },
        evidence_label: { type: "string", maxLength: 240 },
        evidence_value: { type: "string", maxLength: 4000 },
      },
      required: ["task_id"],
    },
  },
];

