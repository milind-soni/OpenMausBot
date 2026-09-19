// Task tools: creating, selecting, and renaming bot/channel tasks.

import { idArg, isRecord, optionalStringArg, stringArg, type Json, type ToolContext, type ToolHandler } from "./context.ts";
import { projectBot, projectChannel, projectTask, taskRoute } from "./shared.ts";

export const handlers = {
  async create_task(args: Json, ctx: ToolContext): Promise<unknown> {
    const targetId = idArg(args, "target_id");
    const title = optionalStringArg(args, "title", { max: 80 });
    const route = taskRoute(args.target_type, targetId);
    const result = await ctx.fetch(route, { method: "POST", body: JSON.stringify(title ? { title } : {}) });
    if (!isRecord(result?.task) || typeof result.task.threadId !== "string") {
      throw new Error("OpenMausBot did not return the created task");
    }
    const activeTaskId = result.bot?.threadId ?? result.group?.threadId ?? result.task?.threadId;
    return {
      success: true,
      targetType: args.target_type,
      targetId,
      task: projectTask(result.task, activeTaskId),
    };
  },
  async switch_task(args: Json, ctx: ToolContext): Promise<unknown> {
    const targetId = idArg(args, "target_id");
    const taskId = idArg(args, "task_id");
    const route = taskRoute(args.target_type, targetId);
    const result = await ctx.fetch(`${route}/${encodeURIComponent(taskId)}?messages=0`, { method: "POST", body: "{}" });
    const target = args.target_type === "bot" ? result?.bot : result?.group;
    return {
      success: true,
      targetType: args.target_type,
      targetId,
      taskId,
      ...(isRecord(target)
        ? { target: args.target_type === "bot" ? projectBot(target) : projectChannel(target) }
        : {}),
    };
  },
  async rename_task(args: Json, ctx: ToolContext): Promise<unknown> {
    const targetId = idArg(args, "target_id");
    const taskId = idArg(args, "task_id");
    const title = stringArg(args, "title", { max: 80 });
    const route = taskRoute(args.target_type, targetId);
    const result = await ctx.fetch(`${route}/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
    if (!isRecord(result?.task)) {
      throw new Error("OpenMausBot did not return the renamed task");
    }
    return {
      success: true,
      targetType: args.target_type,
      targetId,
      task: projectTask(result.task, undefined),
    };
  },
} satisfies Record<string, ToolHandler>;
