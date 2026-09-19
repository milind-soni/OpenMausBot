// Model tools: listing instances and switching an idle bot or task selection.

import { idArg, isRecord, type Json, type ToolContext, type ToolHandler } from "./context.ts";
import { botTaskState, checkedModelSelection, fleet, projectBot, projectTask, records, taskBelongsTo, taskRoute } from "./shared.ts";

export const handlers = {
  async list_available_models(_args: Json, ctx: ToolContext): Promise<unknown> {
    const res = await ctx.fetch("/api/instances");
    return {
      instances: records(res.instances).map((instance) => ({
        instanceId: instance.instanceId,
        driverKind: instance.driverKind,
        displayName: instance.displayName,
        snapshot: { state: instance.snapshot?.state },
        models: instance.models,
        capabilities: instance.capabilities,
        access: instance.access,
      })),
    };
  },
  async set_bot_model(args: Json, ctx: ToolContext): Promise<unknown> {
    const botId = idArg(args, "bot_id");
    const current = await fleet(ctx.fetch);
    const bot = records(current.bots).find((candidate) => candidate.id === botId);
    if (!bot) throw new Error(`Bot not found: ${botId}`);
    if (args.task_id !== undefined) {
      const taskId = idArg(args, "task_id");
      if (!taskBelongsTo(bot, taskId)) throw new Error(`Task '${taskId}' does not belong to bot '${botId}'`);
      if (botTaskState(bot, taskId).busy) throw new Error("Interrupt the task or let it finish before changing its model");
      const selection = await checkedModelSelection(args, ctx.fetch);
      const res = await ctx.fetch(`${taskRoute("bot", botId)}/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: JSON.stringify({ modelSelection: selection, requireAvailableModel: true }),
      });
      if (!isRecord(res?.task)) throw new Error("OpenMausBot did not return the updated task");
      return { success: true, botId, task: projectTask(res.task, bot.threadId) };
    }
    if (bot.busy) throw new Error("Interrupt the bot or let it finish before changing its model");
    const selection = await checkedModelSelection(args, ctx.fetch);
    const res = await ctx.fetch(`/api/bots/${encodeURIComponent(botId)}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: selection, requireAvailableModel: true }),
    });
    if (!isRecord(res?.bot)) {
      throw new Error("OpenMausBot did not return the updated bot");
    }
    return { success: true, bot: projectBot(res.bot) };
  },
} satisfies Record<string, ToolHandler>;
