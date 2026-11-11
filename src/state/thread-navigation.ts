import { notificationTrayPinned } from "@/lib/notification-preferences";
import type { Action, AppState } from "./store";
import { openOwnTeamChat, teamChats } from "./team-chats";
import { teamThreadToOpen } from "./team-side";

interface NotificationThreadOwner {
  id: string;
  threadId: string;
  mainThreadId?: string;
  tasks?: Array<RowThread>;
}

type RowThread = { threadId: string; activity?: string; unread?: boolean; busy?: boolean; routineRunId?: unknown; archivedAt?: unknown; updatedAt?: number; createdAt?: number };

interface NotificationRoutingState {
  bots: NotificationThreadOwner[];
  groups: NotificationThreadOwner[];
}

export function visibleNotificationThread(
  state: NotificationRoutingState & Pick<AppState, "activeView" | "selectedId">,
): string | null {
  if (state.activeView !== "chat") return null;
  return (
    state.bots.find((candidate) => candidate.id === state.selectedId)?.threadId ??
    state.groups.find((candidate) => candidate.id === state.selectedId)?.threadId ??
    null
  );
}

export function botOpensTo(bot: Pick<NotificationThreadOwner, "threadId" | "mainThreadId" | "tasks">, threadsShown: boolean): string {
  return !threadsShown && bot.mainThreadId && bot.tasks?.some((task) => task.threadId === bot.mainThreadId)
    ? bot.mainThreadId : bot.threadId;
}

export function awayFromMainThread(bot: Pick<NotificationThreadOwner, "threadId" | "mainThreadId" | "tasks">, threadsShown: boolean): boolean {
  return !threadsShown && botOpensTo(bot, false) !== bot.threadId;
}

/** On a team's Cloud, the bot's conversation on the side the sidebar shows: the person's own with it under "Just me", its
 * shared chat under "Team". */
export function openBot(
  dispatch: (action: Action) => void,
  bot: Pick<NotificationThreadOwner, "id" | "threadId" | "mainThreadId" | "tasks"> & { yourAccess?: string },
  threadsShown: boolean,
) {
  const shared = teamThreadToOpen(bot, teamChats());
  if (shared) return openBotThread(dispatch, bot, shared, threadsShown);
  if (openOwnTeamChat(dispatch, bot, (threadId) => openBotThread(dispatch, bot, threadId, threadsShown))) return;
  const opened = botOpensTo(bot, threadsShown);
  if (opened === bot.threadId) dispatch({ type: "select", id: bot.id });
  else openBotThread(dispatch, bot, opened, threadsShown);
}

const markRank = (task: RowThread): number | null => {
  if (task.routineRunId) return null;
  if (task.activity === "waiting-on-you") return 0;
  if (task.archivedAt !== undefined) return null;
  if (task.unread) return 1;
  return task.busy || task.activity === "working" ? 2 : null;
};

/** The thread a bot's row or tile is marked for: what waits on the person, then an unread reply, then work under way. The
 * thread the bot opens to wins a tie, then the newest. Null when the row has no mark. */
export function markedThread(bot: Pick<NotificationThreadOwner, "threadId" | "mainThreadId" | "tasks">, threadsShown: boolean): string | null {
  const home = botOpensTo(bot, threadsShown);
  const stamp = (task: RowThread) => task.updatedAt ?? task.createdAt ?? 0;
  const marked = (bot.tasks ?? []).flatMap((task) => { const rank = markRank(task); return rank === null ? [] : [{ task, rank }]; })
    .sort((a, b) => a.rank - b.rank || Number(b.task.threadId === home) - Number(a.task.threadId === home) || stamp(b.task) - stamp(a.task));
  return marked[0]?.task.threadId ?? null;
}

/** A click on a bot's row or tile opens the thread its mark is about; with no mark, or with that thread already on screen,
 * the bot as ever. Every other way into a bot is `openBot`. On a team a bot's row is the person's own chat. */
export function openBotRow(
  dispatch: (action: Action) => void,
  bot: Pick<NotificationThreadOwner, "id" | "threadId" | "mainThreadId" | "tasks"> & { yourAccess?: string },
  threadsShown: boolean,
  onScreen: boolean,
) {
  const marked = teamChats() ? null : markedThread(bot, threadsShown);
  if (!marked || marked === botOpensTo(bot, threadsShown) || (onScreen && marked === bot.threadId)) openBot(dispatch, bot, threadsShown);
  else openBotThread(dispatch, bot, marked, threadsShown);
}

/** With threads hidden the switch alone selects the bot, so the thread left behind keeps its unread mark. */
export function openBotThread(
  dispatch: (action: Action) => void,
  bot: Pick<NotificationThreadOwner, "id" | "threadId">,
  threadId: string,
  threadsShown: boolean,
) {
  if (threadsShown || threadId === bot.threadId) dispatch({ type: "select", id: bot.id });
  dispatch({ type: "switchTask", botId: bot.id, threadId });
}

/** A hand-off's chip for work in a room: the thread it names while the room still has it, else the room. */
export function openRoomThread(dispatch: (action: Action) => void, comm: { groupId: string; threadId?: string }, groups: readonly NotificationThreadOwner[]) {
  dispatch({ type: "select", id: comm.groupId });
  const room = groups.find((candidate) => candidate.id === comm.groupId);
  if (comm.threadId && room?.tasks?.some((task) => task.threadId === comm.threadId)) dispatch({ type: "switchGroupTask", groupId: comm.groupId, threadId: comm.threadId });
}

export interface ThreadTarget {
  botId: string;
  threadId: string;
}

interface ThreadOpeningState extends NotificationRoutingState {
  bots: Array<NotificationThreadOwner & { name: string }>;
}

/** The one way a click on a bot's message reaches its thread, wherever the thread is and whoever started it: a room's, or
 * any bot's own. A thread that is gone says so on its bot, never silently on some other chat. */
export function openThread(
  dispatch: (action: Action) => void,
  target: ThreadTarget,
  state: ThreadOpeningState,
  threadsShown: boolean,
): boolean {
  const owns = (owner: NotificationThreadOwner) =>
    owner.threadId === target.threadId || (owner.tasks ?? []).some((task) => task.threadId === target.threadId);
  // A room notification carries the asker bot with the room's thread id; switching the bot to it would 404.
  const group = state.groups.find(owns), owner = group ? undefined : state.bots.find(owns);
  const named = state.bots.find((candidate) => candidate.id === target.botId);
  if (group) {
    dispatch({ type: "select", id: group.id });
    if (group.threadId !== target.threadId) dispatch({ type: "switchGroupTask", groupId: group.id, threadId: target.threadId });
  } else if (owner) openBotThread(dispatch, owner, target.threadId, threadsShown);
  else if (named) openBot(dispatch, named, threadsShown);
  dispatch({ type: "revealThread", threadId: target.threadId });
  if (group || owner) return true;
  dispatch({ type: "notice", notice: { kind: "thread-gone", botName: named?.name ?? null } });
  return false;
}

type NotificationTray = Pick<AppState, "notificationsOpen" | "notificationsPinned">;

export function closeUnpinnedTray<T extends NotificationTray>(state: T): T {
  return state.notificationsOpen && !state.notificationsPinned ? { ...state, notificationsOpen: false } : state;
}

/** Opening the chat already on screen is not leaving it. */
export function closeTrayUnlessShown(state: AppState, id: string, threadId: string): AppState {
  const chat = [...state.bots, ...state.groups].find((candidate) => candidate.id === id);
  const shownThreadId = chat && "switchingTo" in chat ? chat.switchingTo ?? chat.threadId : chat?.threadId;
  const shown = state.activeView === "chat" && id === state.selectedId && shownThreadId === threadId;
  return shown ? state : closeUnpinnedTray(state);
}

export function withRememberedTrayPin<T extends NotificationTray>(state: T): T {
  return notificationTrayPinned() ? { ...state, notificationsPinned: true } : state;
}
