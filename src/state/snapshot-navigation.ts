import type { Bot, Group, Message } from "./store";

// One branch per transcript array and leaf: every sidebar row, the composer and the chat ask for it on each store
// change, and an unchanged transcript keeps the same array (so memos keyed on it hold).
const branches = new WeakMap<readonly Message[], { leafId: string; path: Message[] }>();

export function visibleMessages(bot: Pick<Bot, "messages" | "activeLeafId">): Message[] {
  const leafId = bot.activeLeafId;
  if (!leafId) return bot.messages;
  const cached = branches.get(bot.messages);
  if (cached?.leafId === leafId) return cached.path;
  const byId = new Map(bot.messages.map((m) => [m.id, m]));
  if (!byId.has(leafId)) return bot.messages;
  const path: Message[] = [];
  let cur = byId.get(leafId);
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  path.reverse();
  branches.set(bot.messages, { leafId, path });
  return path;
}

export function navigatedSince(
  owner: Pick<Bot, "threadId" | "switchingTo"> | undefined,
  since: Readonly<Record<string, number>> | undefined,
  current: Readonly<Record<string, number>>,
): boolean {
  return owner !== undefined && (owner.switchingTo !== undefined
    || (current[owner.threadId] ?? 0) !== (since?.[owner.threadId] ?? 0));
}

function keepNewTasks<T extends { threadId: string }>(previous: T[] | undefined, incoming: T[] | undefined, taskIdsAtStart: ReadonlySet<string> | undefined): T[] | undefined {
  if (!taskIdsAtStart) return incoming;
  const received = new Set(incoming?.map(task => task.threadId));
  const created = previous?.filter(task => !taskIdsAtStart.has(task.threadId) && !received.has(task.threadId)) ?? [];
  return created.length ? [...(incoming ?? []), ...created] : incoming;
}

function viewingHandoff(previous: Bot, incoming: Bot): boolean {
  const task = previous.tasks?.find((candidate) => candidate.threadId === previous.threadId);
  return Boolean(task?.openedBy?.botId) && (incoming.tasks ?? []).some((candidate) => candidate.threadId === previous.threadId);
}

function reconcileTranscript(previous: Message[], incoming: Message[]): Message[] {
  const incomingById = new Map(incoming.map((message) => [message.id, message]));
  const seen = new Set<string>();
  const merged = previous.map((message) => {
    seen.add(message.id);
    return incomingById.get(message.id) ?? message;
  });
  for (const message of incoming) if (!seen.has(message.id)) merged.push(message);
  return merged;
}

export function keepBotNavigation(previous: Bot | undefined, incoming: Bot, preserve: boolean, taskIdsAtStart?: ReadonlySet<string>): Bot {
  const keepHandoff = previous !== undefined && !preserve && viewingHandoff(previous, incoming);
  if ((!preserve && !keepHandoff) || !previous) return incoming;
  const sameOpenHandoff = keepHandoff && incoming.threadId === previous.threadId;
  return {
    ...incoming,
    threadId: previous.threadId,
    tasks: keepNewTasks(previous.tasks, incoming.tasks, taskIdsAtStart),
    switchingTo: previous.switchingTo,
    awaitingThreadSnapshot: previous.awaitingThreadSnapshot,
    messages: sameOpenHandoff ? reconcileTranscript(previous.messages, incoming.messages) : previous.messages,
    hasMore: sameOpenHandoff ? Boolean(previous.hasMore || incoming.hasMore) : previous.hasMore,
    activeLeafId: sameOpenHandoff ? incoming.activeLeafId ?? previous.activeLeafId : previous.activeLeafId,
    pinnedMessageId: previous.pinnedMessageId,
  };
}

export function keepGroupNavigation(previous: Group | undefined, incoming: Group, preserve: boolean, taskIdsAtStart?: ReadonlySet<string>): Group {
  if (!preserve || !previous) return incoming;
  return {
    ...incoming,
    threadId: previous.threadId,
    tasks: keepNewTasks(previous.tasks, incoming.tasks, taskIdsAtStart),
    messages: previous.messages,
    hasMore: previous.hasMore,
    pinnedCwd: previous.pinnedCwd,
    pinnedMessageId: previous.pinnedMessageId,
    usage: previous.usage,
    memberContext: previous.memberContext,
    busyBotId: previous.busyBotId,
    turnStartedAt: previous.turnStartedAt,
  };
}
