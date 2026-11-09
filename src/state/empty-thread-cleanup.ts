import type { Action, AppState, Bot } from "./store";

type Shown = Pick<AppState, "selectedId" | "activeView"> & { bots: Bot[] };

function leavesThread(state: Shown, action: Action): boolean {
  switch (action.type) {
    case "select": return action.id !== state.selectedId;
    case "switchTask": return action.botId !== state.selectedId || action.threadId !== state.bots.find((bot) => bot.id === action.botId)?.threadId;
    case "newTask": return action.cwd === undefined;
    case "showRoutines": case "showTeamMap": case "showFiles": case "showWebPanel": return true;
    default: return false;
  }
}

const draftId = (bot: Pick<Bot, "id" | "threadId">) => `bot:${bot.id}:${bot.threadId}`;

/** `bot.busy` is true while any thread of the bot runs; only the shown thread's own flag says whether it does. */
const threadRuns = (bot: Bot) => bot.tasks?.find((task) => task.threadId === bot.threadId)?.busy === true;

/** Deletes a thread this client created when the person leaves it with no message, draft, attachment or running turn. */
export function createEmptyThreadCleanup(hasDraft: (draftId: string) => boolean) {
  const createdHere = new Set<string>();
  return {
    created: (bot: Pick<Bot, "id" | "threadId">) => { createdHere.add(draftId(bot)); },
    leave(state: Shown, action: Action, dispatch: (action: Action) => void): void {
      const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
      if (!bot || state.activeView !== "chat" || !leavesThread(state, action) || !createdHere.has(draftId(bot))) return;
      if (bot.switchingTo !== undefined || bot.awaitingThreadSnapshot || bot.messages.length > 0 || threadRuns(bot) || hasDraft(draftId(bot))) return;
      createdHere.delete(draftId(bot));
      dispatch({ type: "deleteTask", botId: bot.id, threadId: bot.threadId, silent: true });
    },
  };
}
