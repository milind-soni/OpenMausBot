import type { NotificationTarget } from "@/lib/notify";
import type { Action, AppState } from "./store";
import { openOwnTeamChat } from "./team-chats";

interface NotificationThreadOwner {
  id: string;
  threadId: string;
  mainThreadId?: string;
  tasks?: Array<{ threadId: string }>;
}

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

export function openNotificationTarget(
  dispatch: (action: Action) => void,
  target: NotificationTarget,
  state: NotificationRoutingState,
  threadsShown: boolean,
) {
  // A room notification carries the asker bot with the room's thread id; switching the bot to it would 404.
  const group = state.groups.find(
    (candidate) =>
      candidate.threadId === target.threadId ||
      (candidate.tasks ?? []).some((task) => task.threadId === target.threadId),
  );
  if (group) {
    dispatch({ type: "select", id: group.id });
    if (group.threadId !== target.threadId) {
      dispatch({ type: "switchGroupTask", groupId: group.id, threadId: target.threadId });
    }
    return;
  }
  const bot = state.bots.find((candidate) =>
    candidate.threadId === target.threadId || candidate.tasks?.some((task) => task.threadId === target.threadId)
  ) ?? state.bots.find((candidate) => candidate.id === target.botId);
  if (!bot) {
    dispatch({ type: "select", id: target.botId });
    return;
  }
  const known =
    bot.threadId === target.threadId ||
    (bot.tasks ?? []).some((task) => task.threadId === target.threadId);
  if (known) openBotThread(dispatch, bot, target.threadId, threadsShown);
  else openBot(dispatch, bot, threadsShown);
}

export function botOpensTo(bot: Pick<NotificationThreadOwner, "threadId" | "mainThreadId" | "tasks">, threadsShown: boolean): string {
  return !threadsShown && bot.mainThreadId && bot.tasks?.some((task) => task.threadId === bot.mainThreadId)
    ? bot.mainThreadId : bot.threadId;
}

export function awayFromMainThread(bot: Pick<NotificationThreadOwner, "threadId" | "mainThreadId" | "tasks">, threadsShown: boolean): boolean {
  return !threadsShown && botOpensTo(bot, false) !== bot.threadId;
}

/** On a team's Cloud, the person's own conversation with the bot, never the team's main chat (team-chats.ts). */
export function openBot(
  dispatch: (action: Action) => void,
  bot: Pick<NotificationThreadOwner, "id" | "threadId" | "mainThreadId" | "tasks">,
  threadsShown: boolean,
) {
  if (openOwnTeamChat(dispatch, bot, (threadId) => openBotThread(dispatch, bot, threadId, threadsShown))) return;
  const opened = botOpensTo(bot, threadsShown);
  if (opened === bot.threadId) dispatch({ type: "select", id: bot.id });
  else openBotThread(dispatch, bot, opened, threadsShown);
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

export interface ThreadTarget {
  botId: string;
  threadId: string;
}

interface ThreadOpeningState extends NotificationRoutingState {
  bots: Array<NotificationThreadOwner & { name: string }>;
}

export function openThread(
  dispatch: (action: Action) => void,
  target: ThreadTarget,
  state: ThreadOpeningState,
  threadsShown: boolean,
): boolean {
  const owns = (owner: NotificationThreadOwner) =>
    owner.threadId === target.threadId || (owner.tasks ?? []).some((task) => task.threadId === target.threadId);
  if (state.groups.some(owns) || state.bots.some(owns)) {
    openNotificationTarget(dispatch, target, state, threadsShown);
    dispatch({ type: "revealThread", threadId: target.threadId });
    return true;
  }
  const bot = state.bots.find((candidate) => candidate.id === target.botId);
  if (bot) openBot(dispatch, bot, threadsShown);
  dispatch({ type: "notice", notice: { kind: "thread-gone", botName: bot?.name ?? null } });
  return false;
}
