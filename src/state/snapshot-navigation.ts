import { placeUnreadDivider } from "@/lib/unread-divider";
import { reconcileSnapshotQueues, replaceBotQueues } from "./queue-receipts";
import { mergeTaskStamps } from "./thread-stamps";
import type { Action, AppState, Bot, Group, Message } from "./store";

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

export function keepBotNavigation(previous: Bot | undefined, incoming: Bot, preserve: boolean, taskIdsAtStart?: ReadonlySet<string>): Bot {
  if (!preserve || !previous) return incoming;
  return {
    ...incoming,
    threadId: previous.threadId,
    tasks: keepNewTasks(previous.tasks, incoming.tasks, taskIdsAtStart),
    switchingTo: previous.switchingTo,
    awaitingThreadSnapshot: previous.awaitingThreadSnapshot,
    messages: previous.messages,
    hasMore: previous.hasMore,
    activeLeafId: previous.activeLeafId,
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

export function reduceHydrate(state: AppState, action: Extract<Action, { type: "hydrate" }>): AppState {
  const known = (id: string) => action.bots.some((b) => b.id === id) || action.groups.some((g) => g.id === id);
  const resume = action.resumeId;
  const resumed =
    resume && (action.bots.some((b) => b.id === resume && !b.hidden) || action.groups.some((g) => g.id === resume)) ? resume : "";
  const selectedId = state.selectedId && known(state.selectedId) ? state.selectedId : resumed || (action.bots[0]?.id ?? "");
  const hydrated = {
    ...state,
    bots: action.bots.map((sent) => {
      let bot = sent.messages ? sent : { ...sent, messages: [] };
      const previous = state.bots.find((candidate) => candidate.id === bot.id);
      if (bot.needsHistory && previous?.threadId === bot.threadId && (!state.chatV2 || bot.busy)) bot = { ...bot, messages: previous.messages, hasMore: previous.hasMore };
      return keepBotNavigation(previous, previous ? { ...bot, tasks: mergeTaskStamps(previous.tasks, bot.tasks) } : bot,
        action.preserveNavigation === true && navigatedSince(previous, action.navigationSince, state.transcriptGeneration), action.taskIdsAtStart);
    }),
    groups: action.groups.map((group) => {
      const previous = state.groups.find((candidate) => candidate.id === group.id);
      const merged = previous ? { ...group, ...(group.needsHistory && previous.threadId === group.threadId ? { messages: previous.messages, hasMore: previous.hasMore } : {}), tasks: mergeTaskStamps(previous.tasks, group.tasks) } : group;
      // The wire carries an explicitly-cleared description as null; client state keeps it absent.
      if (merged.description === null) merged.description = undefined;
      return keepGroupNavigation(previous, merged, action.preserveNavigation === true && navigatedSince(previous, action.navigationSince, state.transcriptGeneration), action.taskIdsAtStart);
    }),
    sections: action.sections ?? [],
    computerControl: action.computerControl,
    selectedId,
    hydrated: true as const,
    backgroundThreadEvents: {},
    loadingOlder: {},
    transcriptGeneration: Object.fromEntries(
      [...action.bots, ...action.groups].map(({ threadId }) => [threadId, (state.transcriptGeneration[threadId] ?? 0) + 1]),
    ),
    modelVariantSessions: {},
  };
  const held = [...hydrated.bots, ...hydrated.groups].find((owner) => owner.threadId === state.unreadDivider?.threadId);
  if (held) hydrated.unreadDivider = placeUnreadDivider(state.unreadDivider, held.threadId, visibleMessages(held), Boolean(held.hasMore || held.needsHistory));
  return reconcileSnapshotQueues(
    action.botQueuedMessages ? replaceBotQueues(hydrated, action.botQueuedMessages) : hydrated,
    [...action.bots, ...action.groups],
  );
}
