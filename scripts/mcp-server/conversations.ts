// Conversation tools: bounded waits and interruption across bots and channels.

import { idArg, isRecord, parsePositiveLimit, ToolInputError, type Json, type ToolContext, type ToolHandler } from "./context.ts";
import { botTaskState, fleet, projectBot, projectChannel, projectMessage, records, taskBelongsTo } from "./shared.ts";

function messageNeedsInput(message: Record<string, any>): boolean {
  const card = isRecord(message.card) && message.card.requestId && !message.card.answered && !message.card.dismissed;
  const connector = isRecord(message.connector) &&
    !message.connector.dismissed &&
    !message.connector.resumed &&
    message.connector.status !== "connected";
  const secret = isRecord(message.secret) && !message.secret.provided && !message.secret.dismissed;
  return Boolean(card || connector || secret);
}

function dispatchFailedAfterLatestUser(messages: Array<Record<string, any>>): boolean {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const turnMessages = messages.slice(lastUser + 1);
  // Only an explicit terminal receipt overrides prose. Existing providers
  // also emit diagnostics on intentional cancellation, which remain settled.
  if (turnMessages.some((message) => message.tool?.terminal === true && message.tool.ok === false)) return true;
  if (turnMessages.some((message) => message.role === "bot" && message.kind === "text" && message.text?.trim())) {
    return false;
  }
  return turnMessages.some(
    (message) =>
      message.kind === "activity" &&
      message.tool?.ok === false &&
      typeof message.tool?.name === "string" &&
      /^error:/i.test(message.tool.name.trim()),
  );
}

async function conversationTail(
  fetcher: (path: string, options?: RequestInit) => Promise<any>,
  taskId: string,
  limit = 10,
) {
  const page = await fetcher(`/api/threads/${encodeURIComponent(taskId)}/messages?limit=${limit}`);
  const raw = records(page.messages);
  return {
    raw,
    messages: raw.map(projectMessage),
    hasMore: Boolean(page.hasMore),
  };
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Request cancelled"));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Request cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const handlers = {
  async wait_for_conversation(args: Json, ctx: ToolContext): Promise<unknown> {
    const targetType = args.target_type;
    if (targetType !== "bot" && targetType !== "channel") {
      throw new ToolInputError("target_type must be bot or channel");
    }
    const targetId = idArg(args, "target_id");
    const timeoutSeconds = parsePositiveLimit(args.timeout_seconds, 30, 120);
    const deadline = Date.now() + timeoutSeconds * 1_000;
    const startupGraceDeadline = Math.min(deadline, Date.now() + 750);
    let state = await fleet(ctx.fetch);
    const collection = targetType === "bot" ? records(state.bots) : records(state.groups);
    let target = collection.find((candidate) => candidate.id === targetId);
    if (!target) throw new Error(`${targetType === "bot" ? "Bot" : "Channel"} not found: ${targetId}`);
    const taskId = args.task_id === undefined ? String(target.threadId) : idArg(args, "task_id");
    if (!taskBelongsTo(target, taskId)) {
      throw new Error(`Task '${taskId}' does not belong to ${targetType} '${targetId}'`);
    }
    let sawBusy = false;
    while (true) {
      const liveCollection = targetType === "bot" ? records(state.bots) : records(state.groups);
      target = liveCollection.find((candidate) => candidate.id === targetId);
      if (!target) throw new Error(`${targetType === "bot" ? "Bot" : "Channel"} not found: ${targetId}`);
      if (!taskBelongsTo(target, taskId)) {
        throw new Error(`Task '${taskId}' no longer belongs to ${targetType} '${targetId}'`);
      }
      const projectedTarget = targetType === "bot" ? projectBot(target) : projectChannel(target);
      const terminal = async (status: string, existingTail?: Awaited<ReturnType<typeof conversationTail>>) => {
        const tail = existingTail ?? await conversationTail(ctx.fetch, taskId);
        const needsInput = tail.raw.some(messageNeedsInput);
        const terminalStatus = status === "settled" && dispatchFailedAfterLatestUser(tail.raw)
          ? "failed"
          : status;
        return {
          status: needsInput ? "needs-user" : terminalStatus,
          targetType,
          targetId,
          taskId,
          target: projectedTarget,
          messages: tail.messages,
          hasMore: tail.hasMore,
        };
      };

      if (targetType === "bot") {
        const task = botTaskState(target, taskId);
        const busyChannel = task === target && records(state.groups).find((channel) => channel.busyBotId === targetId);
        if (busyChannel) {
          throw new Error(`Bot '${targetId}' is working in channel '${busyChannel.id}'; wait on that channel instead`);
        }
        if (task.activity === "waiting-on-you") return terminal("needs-user");
        if (task.activity === "dead") return terminal("failed");
        if (task.activity === "no-signal") return terminal("stalled");
        if (!task.busy) return terminal("settled");
        sawBusy = true;
      } else {
        if (target.threadId !== taskId) return terminal("settled");
        const tail = await conversationTail(ctx.fetch, taskId);
        if (tail.raw.some(messageNeedsInput)) {
          return terminal("needs-user", tail);
        }
        const channelWorking = target.working === true || Boolean(target.busyBotId);
        if (channelWorking) {
          sawBusy = true;
          const busyBotId = target.busyBotId;
          if (busyBotId) {
            const speaker = records(state.bots).find((bot) => bot.id === busyBotId);
            if (!speaker) return terminal("stalled");
            if (speaker.activity === "waiting-on-you") return terminal("needs-user");
            if (speaker.activity === "dead") return terminal("failed");
            if (speaker.activity === "no-signal") return terminal("stalled");
          }
        } else {
          const latest = tail.raw.at(-1);
          // New servers expose `working` synchronously before returning a
          // channel send. The short grace remains only for older servers
          // that have no operation-level field and report a user message
          // just before their first speaker becomes busy.
          if (sawBusy || target.working === false || latest?.role !== "user") {
            return terminal("settled", tail);
          }
          if (Date.now() >= startupGraceDeadline) {
            return terminal("settled", tail);
          }
        }
      }

      if (Date.now() >= deadline) return terminal("timed-out");
      await sleep(Math.min(500, Math.max(0, deadline - Date.now())), ctx.signal);
      state = await fleet(ctx.fetch);
    }
  },
  async interrupt_conversation(args: Json, ctx: ToolContext): Promise<unknown> {
    const targetType = args.target_type;
    if (targetType !== "bot" && targetType !== "channel") {
      throw new ToolInputError("target_type must be bot or channel");
    }
    const targetId = idArg(args, "target_id");
    const current = await fleet(ctx.fetch);
    const target = (targetType === "bot" ? records(current.bots) : records(current.groups))
      .find((candidate) => candidate.id === targetId);
    if (!target) throw new Error(`${targetType === "bot" ? "Bot" : "Channel"} not found: ${targetId}`);
    const taskId = args.task_id === undefined ? String(target.threadId) : idArg(args, "task_id");
    if (!taskBelongsTo(target, taskId)) throw new Error(`Task '${taskId}' does not belong to ${targetType} '${targetId}'`);
    if (targetType === "bot") {
      const busyChannel = botTaskState(target, taskId) === target && records(current.groups).find((channel) => channel.busyBotId === targetId);
      if (busyChannel) {
        throw new Error(`Bot '${targetId}' is working in channel '${busyChannel.id}'; interrupt that channel instead`);
      }
    }
    const route = targetType === "bot" ? "bots" : "groups";
    await ctx.fetch(`/api/${route}/${encodeURIComponent(targetId)}/interrupt`, {
      method: "POST",
      body: JSON.stringify({ threadId: taskId }),
    });
    return { success: true, targetType, targetId, taskId };
  },
} satisfies Record<string, ToolHandler>;
