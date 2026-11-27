import { branchLeafFrom } from "../../shared/conversation-branch";
import type { AppState, Bot, Group, Message } from "./store";

export function switchBotBranch(state: AppState, botId: string, threadId: string, messageId: string): AppState {
  const panel = state.forkPanel;
  if (panel?.kind === "bot" && panel.ownerId === botId && panel.threadId === threadId) {
    return { ...state, forkPanel: { ...panel, activeLeafId: branchLeafFrom(panel.messages, messageId) } };
  }
  return { ...state, bots: state.bots.map((bot) => bot.id === botId && bot.threadId === threadId
    ? { ...bot, activeLeafId: branchLeafFrom(bot.messages, messageId) } : bot) };
}

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

/** The conversation a snapshot opens on: the one already open when the snapshot still has it, else the one to resume,
 * else the first bot. */
export function hydratedSelectedId(selectedId: string, bots: readonly Pick<Bot, "id" | "hidden">[], groups: readonly Pick<Group, "id">[], resumeId: string | undefined): string {
  const known = (id: string) => bots.some((b) => b.id === id) || groups.some((g) => g.id === id);
  const resumed = resumeId && (bots.some((b) => b.id === resumeId && !b.hidden) || groups.some((g) => g.id === resumeId)) ? resumeId : "";
  return selectedId && known(selectedId) ? selectedId : resumed || (bots[0]?.id ?? "");
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
  const task = previous.tasks?.find(candidate => candidate.threadId === previous.threadId);
  return Boolean(task?.openedBy?.botId) && (incoming.tasks ?? []).some(candidate => candidate.threadId === previous.threadId);
}

/** The snapshot is the server's copy of the hand-off from its first row on, so a send it confirmed or a row it no longer
 * has does not linger; only the rows loaded before that first row stay. Without an overlap the snapshot wins. */
function reconcileTranscript(previous: Message[], incoming: Message[]): { messages: Message[]; earlier: boolean } {
  const start = incoming[0] ? previous.findIndex(message => message.id === incoming[0]!.id) : -1;
  return start > 0 ? { messages: [...previous.slice(0, start), ...incoming], earlier: true } : { messages: incoming, earlier: false };
}

export function keepBotNavigation(previous: Bot | undefined, incoming: Bot, preserve: boolean, taskIdsAtStart?: ReadonlySet<string>): Bot {
  // A reconnect snapshot does not preserve navigation, and the server often still names the older thread.
  // A hand-off another bot opened stays on screen while that thread remains.
  const keepHandoff = previous !== undefined && !preserve && viewingHandoff(previous, incoming);
  if ((!preserve && !keepHandoff) || !previous) return incoming;
  const sameOpenHandoff = keepHandoff && incoming.threadId === previous.threadId;
  const reconciled = sameOpenHandoff ? reconcileTranscript(previous.messages, incoming.messages) : null;
  return {
    ...incoming,
    threadId: previous.threadId,
    tasks: keepNewTasks(previous.tasks, incoming.tasks, taskIdsAtStart),
    switchingTo: previous.switchingTo,
    awaitingThreadSnapshot: previous.awaitingThreadSnapshot,
    messages: reconciled ? reconciled.messages : previous.messages,
    hasMore: reconciled ? (reconciled.earlier ? previous.hasMore : incoming.hasMore) : previous.hasMore,
    activeLeafId: sameOpenHandoff ? (incoming.activeLeafId === undefined ? previous.activeLeafId : incoming.activeLeafId) : previous.activeLeafId,
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
