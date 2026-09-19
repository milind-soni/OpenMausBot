// Notification and thread-open routing, extracted verbatim from the
// reducer: resolving a notification or #Title link to the conversation that
// owns its thread, then selecting it. Pure dispatch mapping; no React.

import type { NotificationTarget } from "@/lib/notify";
import type { Action } from "./action";
import type { AppState } from "./reducer";

interface NotificationThreadOwner {
  id: string;
  threadId: string;
  tasks?: Array<{ threadId: string }>;
}

interface NotificationRoutingState {
  bots: NotificationThreadOwner[];
  groups: NotificationThreadOwner[];
}

/** The exact conversation currently on screen. A focused window is not
 * enough to suppress an alert when its actionable card is in another task. */
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
) {
  // A room's approval/question notification carries the asker bot with the
  // GROUP's thread id; asking the bot to switch to that thread would 404.
  // Open the room itself. Cross-bot routine receipts carry the executing
  // bot but report into the requesting bot's thread: resolve its actual
  // owner before selecting. An unknown/deleted thread falls back to the bot.
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
  dispatch({ type: "select", id: bot?.id ?? target.botId });
  if (!bot) return;
  const known =
    bot.threadId === target.threadId ||
    (bot.tasks ?? []).some((task) => task.threadId === target.threadId);
  if (known) dispatch({ type: "switchTask", botId: bot.id, threadId: target.threadId });
}

/** A thread the person can open from a chip or a #Title link. */
export interface ThreadTarget {
  botId: string;
  threadId: string;
}

interface ThreadOpeningState extends NotificationRoutingState {
  bots: Array<NotificationThreadOwner & { name: string }>;
}

/** Open a thread the person clicked: select its bot (or room) and switch
 * the VIEW to that thread — never the work; a turn running elsewhere keeps
 * running (the #981 rule). The sidebar then reveals the row. A thread this
 * client no longer knows (deleted, or not yet announced) falls back to the
 * bot with a quiet notice rather than a 404 or a crash. Returns whether the
 * thread was found. */
export function openThread(
  dispatch: (action: Action) => void,
  target: ThreadTarget,
  state: ThreadOpeningState,
): boolean {
  const owns = (owner: NotificationThreadOwner) =>
    owner.threadId === target.threadId || (owner.tasks ?? []).some((task) => task.threadId === target.threadId);
  if (state.groups.some(owns) || state.bots.some(owns)) {
    openNotificationTarget(dispatch, target, state);
    dispatch({ type: "revealThread", threadId: target.threadId });
    return true;
  }
  const bot = state.bots.find((candidate) => candidate.id === target.botId);
  if (bot) dispatch({ type: "select", id: bot.id });
  dispatch({ type: "notice", notice: { kind: "thread-gone", botName: bot?.name ?? null } });
  return false;
}

