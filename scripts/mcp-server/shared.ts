// Helpers shared by several domain handlers: the API projections and the
// owner/task checks every tool performs the same way. Bodies are unchanged
// from the old dispatch switch in mcp-server.ts.
import { isRecord, optionalStringArg, stringArg, ToolInputError } from "./context.ts";

export function records(value: unknown): Array<Record<string, any>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export async function fleet(fetcher: (path: string, options?: RequestInit) => Promise<any>) {
  return fetcher("/api/bots?messages=0");
}

export function projectTask(task: Record<string, any>, activeThreadId: unknown) {
  return {
    taskId: task.threadId,
    title: task.title,
    createdAt: task.createdAt,
    ...(typeof task.busy === "boolean" ? { busy: task.busy } : {}),
    ...(task.activity ? { activity: task.activity } : {}),
    ...(task.modelSelection ? { modelSelection: task.modelSelection } : {}),
    ...(typeof activeThreadId === "string" ? { active: task.threadId === activeThreadId } : {}),
    ...(task.usage ? { usage: task.usage } : {}),
  };
}

export function botTaskState(bot: Record<string, any>, taskId: string) {
  const task = records(bot.tasks).find((candidate) => candidate.threadId === taskId);
  if (task && (typeof task.busy === "boolean" || typeof task.activity === "string")) return task;
  // Older servers cannot run non-selected tasks and expose only bot activity.
  return bot.threadId === taskId ? bot : { busy: false, activity: "idle" };
}

export function projectBot(bot: Record<string, any>) {
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    section: bot.section ?? null,
    chiefOfStaff: Boolean(bot.chiefOfStaff),
    modelSelection: bot.modelSelection,
    busy: Boolean(bot.busy),
    activity: bot.activity,
    unread: Boolean(bot.unread),
    activeTaskId: bot.threadId,
    tasks: records(bot.tasks).map((task) => projectTask(task, bot.threadId)),
  };
}

export function projectChannel(channel: Record<string, any>) {
  return {
    id: channel.id,
    name: channel.name,
    memberIds: channel.memberIds,
    bulletin: channel.bulletin,
    defaultResponder: channel.defaultResponder,
    section: channel.section ?? null,
    directMessage: Boolean(channel.dm),
    working: Boolean(channel.working),
    busyBotId: channel.busyBotId ?? null,
    activeTaskId: channel.threadId,
    tasks: records(channel.tasks).map((task) => projectTask(task, channel.threadId)),
  };
}

export function projectMessage(message: Record<string, any>) {
  const card = isRecord(message.card)
    ? {
        title: message.card.title,
        subtitle: message.card.subtitle,
        options: message.card.options,
        answered: message.card.answered,
        dismissed: message.card.dismissed,
      }
    : undefined;
  const tool = isRecord(message.tool)
    ? { name: message.tool.name, ok: message.tool.ok, spoken: message.tool.spoken, setup: message.tool.setup,
        ...(message.tool.terminal === true ? { terminal: true } : {}),
      }
    : undefined;
  const connector = isRecord(message.connector)
    ? {
        slug: message.connector.slug,
        label: message.connector.label,
        description: message.connector.description,
        status: message.connector.status,
        dismissed: message.connector.dismissed,
        resumed: message.connector.resumed,
      }
    : undefined;
  const secret = isRecord(message.secret)
    ? {
        target: message.secret.target,
        label: message.secret.label,
        description: message.secret.description,
        placeholder: message.secret.placeholder,
        helpUrl: message.secret.helpUrl,
        provided: message.secret.provided,
        dismissed: message.secret.dismissed,
        resumed: message.secret.resumed,
      }
    : undefined;
  return {
    id: message.id,
    at: message.at,
    role: message.role,
    kind: message.kind,
    text: message.text,
    from: message.from,
    replyToId: message.replyToId,
    reactions: message.reactions,
    steered: message.steered,
    queued: message.queued,
    ...(tool ? { tool } : {}),
    ...(card ? { card } : {}),
    ...(connector ? { connector } : {}),
    ...(secret ? { secret } : {}),
    ...(message.kind === "screen" ? { hasImage: Boolean(message.hasImage || message.png) } : {}),
  };
}

export function taskBelongsTo(owner: Record<string, any>, taskId: string): boolean {
  return owner.threadId === taskId || records(owner.tasks).some((task) => task.threadId === taskId);
}

export function taskRoute(targetType: unknown, targetId: string): string {
  if (targetType === "bot") return `/api/bots/${encodeURIComponent(targetId)}/tasks`;
  if (targetType === "channel") return `/api/groups/${encodeURIComponent(targetId)}/tasks`;
  throw new ToolInputError("target_type must be bot or channel");
}

export async function checkedModelSelection(
  args: Record<string, unknown>,
  fetcher: (path: string, options?: RequestInit) => Promise<any>,
) {
  const instanceId = stringArg(args, "instance_id");
  const model = stringArg(args, "model");
  const effort = optionalStringArg(args, "effort");
  const described = await fetcher("/api/instances");
  const instance = records(described.instances).find((candidate) => candidate.instanceId === instanceId);
  if (!instance) throw new ToolInputError(`model instance not found: ${instanceId}`);
  if (instance.snapshot?.state !== "available") throw new ToolInputError(`model instance is unavailable: ${instanceId}`);
  const models = isRecord(instance.models) ? instance.models : {};
  const offered = records(models.options).map((option) => option.id).filter((id) => typeof id === "string");
  if (models.default !== model && !offered.includes(model)) {
    throw new ToolInputError(`model '${model}' is not offered by instance '${instanceId}'`);
  }
  const efforts = Array.isArray(instance.capabilities?.effortLevels) ? instance.capabilities.effortLevels : [];
  if (effort && !efforts.includes(effort)) {
    throw new ToolInputError(`effort '${effort}' is not offered by instance '${instanceId}'`);
  }
  return { instanceId, model, ...(effort ? { effort } : {}) };
}
