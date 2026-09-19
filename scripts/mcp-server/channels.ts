// Channel tools: multi-agent groups, their members, and message surface.

import { idArg, isRecord, optionalStringArg, parsePositiveLimit, stringArg, stringArrayArg, ToolInputError, type Json, type ToolContext, type ToolHandler } from "./context.ts";
import { fleet, projectChannel, projectMessage, records, taskBelongsTo } from "./shared.ts";

function normalizeResponder(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ToolInputError("default_responder must be an object");
  if (value.kind === "everyone" || value.kind === "mentions") return { kind: value.kind };
  if (value.kind === "member" && typeof value.bot_id === "string" && value.bot_id.trim()) {
    return { kind: "member", botId: value.bot_id.trim() };
  }
  throw new ToolInputError("default_responder is invalid");
}

export const handlers = {
  async list_channels(_args: Json, ctx: ToolContext): Promise<unknown> {
    const res = await fleet(ctx.fetch);
    return { channels: records(res.groups).map(projectChannel) };
  },
  async get_channel_messages(args: Json, ctx: ToolContext): Promise<unknown> {
    const channelId = idArg(args, "channel_id");
    const res = await fleet(ctx.fetch);
    const channel = records(res.groups).find((candidate) => candidate.id === channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    const taskId = args.task_id === undefined ? String(channel.threadId) : idArg(args, "task_id");
    if (!taskBelongsTo(channel, taskId)) throw new Error(`Task '${taskId}' does not belong to channel '${channelId}'`);
    const limit = parsePositiveLimit(args.limit, 30, 200);
    const page = await ctx.fetch(`/api/threads/${encodeURIComponent(taskId)}/messages?limit=${limit}`);
    return {
      channel: projectChannel(channel),
      taskId,
      messages: records(page.messages).map(projectMessage),
      hasMore: Boolean(page.hasMore),
    };
  },
  async send_channel_message(args: Json, ctx: ToolContext): Promise<unknown> {
    const channelId = idArg(args, "channel_id");
    const text = stringArg(args, "text", { trim: true, max: 100_000 });
    const state = await fleet(ctx.fetch);
    const channel = records(state.groups).find((candidate) => candidate.id === channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    const taskId = args.task_id === undefined ? String(channel.threadId) : idArg(args, "task_id");
    if (!taskBelongsTo(channel, taskId)) {
      throw new Error(`Task '${taskId}' does not belong to channel '${channelId}'`);
    }
    if (channel.threadId !== taskId) {
      throw new Error(`Task '${taskId}' is not active for channel '${channelId}'; switch to it before sending`);
    }
    await ctx.fetch(`/api/groups/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, threadId: taskId }),
    });
    return { success: true, channelId, taskId };
  },
  async create_channel(args: Json, ctx: ToolContext): Promise<unknown> {
    const name = stringArg(args, "name", { max: 100 });
    const memberIds = stringArrayArg(args, "member_ids");
    const section = optionalStringArg(args, "section", { max: 60 });
    const bulletin = optionalStringArg(args, "bulletin", { trim: false, allowEmpty: true, max: 12_000 }) ?? "";
    const requestedResponder = normalizeResponder(args.default_responder);
    if (requestedResponder?.kind === "member" && !memberIds.includes(requestedResponder.botId)) {
      throw new ToolInputError("default_responder bot must be a channel member");
    }
    const responder = requestedResponder ?? { kind: "member", botId: memberIds[0] };
    const created = await ctx.fetch("/api/groups", {
      method: "POST",
      body: JSON.stringify({
        name,
        memberIds,
        ...(section ? { section } : {}),
        setup: { bulletin, defaultResponder: responder },
      }),
    });
    if (!isRecord(created?.group) || typeof created.group.id !== "string") {
      throw new Error("OpenMausBot did not return the created channel");
    }
    return { success: true, channel: projectChannel(created.group) };
  },
  async update_channel(args: Json, ctx: ToolContext): Promise<unknown> {
    const channelId = idArg(args, "channel_id");
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = stringArg(args, "name", { max: 100 });
    if (args.member_ids !== undefined) patch.memberIds = stringArrayArg(args, "member_ids");
    if (args.section !== undefined) patch.section = args.section === null ? null : stringArg(args, "section", { max: 60 });
    if (args.bulletin !== undefined) patch.bulletin = stringArg(args, "bulletin", { trim: false, allowEmpty: true, max: 12_000 });
    if (args.default_responder !== undefined) patch.defaultResponder = normalizeResponder(args.default_responder);
    if (Object.keys(patch).length === 0) throw new ToolInputError("provide at least one channel field to update");
    const memberIds = patch.memberIds as string[] | undefined;
    const responder = patch.defaultResponder as Record<string, string> | undefined;
    if (memberIds && responder?.kind === "member" && !memberIds.includes(responder.botId)) {
      throw new ToolInputError("default_responder bot must be a channel member");
    }
    const result = await ctx.fetch(`/api/groups/${encodeURIComponent(channelId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (!isRecord(result?.group)) {
      throw new Error("OpenMausBot did not return the updated channel");
    }
    return { success: true, channel: projectChannel(result.group) };
  },
} satisfies Record<string, ToolHandler>;
