import type { Action, AppState, Bot } from "./store";

type Leaving = Pick<AppState, "selectedId" | "activeView">;

/** Whether `action` moves the person away from the thread `state` is showing. */
function leavesThread(state: Leaving & { bots: Bot[] }, action: Action): boolean {
  switch (action.type) {
    case "select": return action.id !== state.selectedId;
    case "switchTask": return action.botId !== state.selectedId || action.threadId !== state.bots.find((bot) => bot.id === action.botId)?.threadId;
    case "newTask": return action.cwd === undefined;
    case "showRoutines": case "showTeamMap": case "showFiles": case "showWebPanel": return true;
    default: return false;
  }
}

/** The thread to delete when `action` leaves it: one this client created that never got a message, draft or turn. */
export function abandonedNewThread(
  state: Leaving & { bots: Bot[] },
  action: Action,
  createdHere: ReadonlySet<string>,
  hasDraft: (draftId: string) => boolean,
): { botId: string; threadId: string } | null {
  if (state.activeView !== "chat" || !leavesThread(state, action)) return null;
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
  if (!bot || bot.switchingTo !== undefined || bot.awaitingThreadSnapshot) return null;
  const draftId = `bot:${bot.id}:${bot.threadId}`;
  if (!createdHere.has(draftId) || bot.messages.length > 0 || bot.busy || hasDraft(draftId)) return null;
  return { botId: bot.id, threadId: bot.threadId };
}
