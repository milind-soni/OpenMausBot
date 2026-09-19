// Bot tools: profiles plus the per-bot task and message surface.

import { idArg, isRecord, optionalStringArg, parsePositiveLimit, stringArg, ToolInputError, type Json, type ToolContext, type ToolHandler } from "./context.ts";
import { botTaskState, checkedModelSelection, fleet, projectBot, projectMessage, records, taskBelongsTo } from "./shared.ts";

export const handlers = {
  async list_bots(_args: Json, ctx: ToolContext): Promise<unknown> {
    const res = await fleet(ctx.fetch);
    return { bots: records(res.bots).map(projectBot) };
  },
  async get_bot_messages(args: Json, ctx: ToolContext): Promise<unknown> {
    const botId = idArg(args, "bot_id");
    const res = await fleet(ctx.fetch);
    const bot = records(res.bots).find((candidate) => candidate.id === botId);
    if (!bot) throw new Error(`Bot not found: ${botId}`);
    const taskId = args.task_id === undefined ? String(bot.threadId) : idArg(args, "task_id");
    if (!taskBelongsTo(bot, taskId)) throw new Error(`Task '${taskId}' does not belong to bot '${botId}'`);
    const limit = parsePositiveLimit(args.limit, 30, 200);
    const page = await ctx.fetch(`/api/threads/${encodeURIComponent(taskId)}/messages?limit=${limit}`);
    return {
      bot: projectBot(bot),
      taskId,
      messages: records(page.messages).map(projectMessage),
      hasMore: Boolean(page.hasMore),
    };
  },
  async send_bot_message(args: Json, ctx: ToolContext): Promise<unknown> {
    const botId = idArg(args, "bot_id");
    const text = stringArg(args, "text", { trim: true, max: 100_000 });
    const state = await fleet(ctx.fetch);
    const bot = records(state.bots).find((candidate) => candidate.id === botId);
    if (!bot) throw new Error(`Bot not found: ${botId}`);
    const taskId = args.task_id === undefined ? String(bot.threadId) : idArg(args, "task_id");
    if (!taskBelongsTo(bot, taskId)) throw new Error(`Task '${taskId}' does not belong to bot '${botId}'`);
    const busyChannel = records(state.groups).find((channel) => channel.busyBotId === botId);
    if (busyChannel) {
      throw new Error(`Bot '${botId}' is working in channel '${busyChannel.id}'; send to or interrupt that channel instead`);
    }
    await ctx.fetch(`/api/bots/${encodeURIComponent(botId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, threadId: taskId }),
    });
    return { success: true, botId, taskId };
  },
  async create_bot(args: Json, ctx: ToolContext): Promise<unknown> {
    const name = stringArg(args, "name", { max: 100 });
    const title = optionalStringArg(args, "title", { trim: false, allowEmpty: true, max: 200 });
    const description = optionalStringArg(args, "description", { trim: false, allowEmpty: true, max: 4_000 });
    const section = optionalStringArg(args, "section", { max: 60 });
    const wantsModel = args.instance_id !== undefined || args.model !== undefined || args.effort !== undefined;
    if (wantsModel && (args.instance_id === undefined || args.model === undefined)) {
      throw new ToolInputError("instance_id and model must be provided together");
    }
    const selection = wantsModel ? await checkedModelSelection(args, ctx.fetch) : undefined;
    const created = await ctx.fetch("/api/bots", {
      method: "POST",
      body: JSON.stringify({
        name,
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(section !== undefined ? { section } : {}),
        ...(selection ? { modelSelection: selection, requireAvailableModel: true } : {}),
      }),
    });
    if (!isRecord(created?.bot) || typeof created.bot.id !== "string") {
      throw new Error("OpenMausBot did not return the created bot");
    }
    return { success: true, bot: projectBot(created.bot) };
  },
  async update_bot_profile(args: Json, ctx: ToolContext): Promise<unknown> {
    const botId = idArg(args, "bot_id");
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = stringArg(args, "name", { max: 100 });
    if (args.title !== undefined) patch.title = stringArg(args, "title", { trim: false, allowEmpty: true, max: 200 });
    if (args.description !== undefined) patch.description = stringArg(args, "description", { trim: false, allowEmpty: true, max: 4_000 });
    if ("section" in args) patch.section = args.section === null ? null : stringArg(args, "section", { max: 60 });
    if (!Object.keys(patch).length) throw new ToolInputError("provide at least one profile field to update");
    const result = await ctx.fetch(`/api/bots/${encodeURIComponent(botId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (!isRecord(result?.bot)) {
      throw new Error("OpenMausBot did not return the updated bot");
    }
    return { success: true, bot: projectBot(result.bot) };
  },
  async edit_bot_message(args: Json, ctx: ToolContext): Promise<unknown> {
    const botId = idArg(args, "bot_id");
    const messageId = idArg(args, "message_id");
    const text = stringArg(args, "text", { trim: true });
    const current = await fleet(ctx.fetch);
    const bot = records(current.bots).find((candidate) => candidate.id === botId);
    if (!bot) throw new Error(`Bot not found: ${botId}`);
    let threadId: string | undefined;
    if (args.task_id !== undefined) {
      threadId = idArg(args, "task_id");
      if (!taskBelongsTo(bot, threadId)) throw new Error(`Task '${threadId}' does not belong to bot '${botId}'`);
      if (botTaskState(bot, threadId).busy) throw new Error("Interrupt the task or let it finish before editing a message");
    } else if (bot.busy) {
      // the server refuses a rewind under a live turn — branching beneath
      // a dying turn is how a thread ends up with two tails
      throw new Error("Interrupt the bot or let it finish before editing a message");
    }
    const res = await ctx.fetch(
      `/api/bots/${encodeURIComponent(botId)}/messages/${encodeURIComponent(messageId)}/edit`,
      { method: "POST", body: JSON.stringify({ text, ...(threadId ? { threadId } : {}) }) },
    );
    return { success: true, botId, message: res?.message ?? null };
  },
} satisfies Record<string, ToolHandler>;
