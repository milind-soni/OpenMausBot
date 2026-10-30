import type { AppState } from "@/state/store";

type ShownChatState = Pick<AppState, "activeView" | "selectedId" | "bots" | "groups">;

export function shownChatIsUnread(state: ShownChatState): boolean {
  if (state.activeView !== "chat" || !state.selectedId) return false;
  const group = state.groups.find((candidate) => candidate.id === state.selectedId);
  if (group) return group.unread;
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
  if (!bot) return false;
  const shown = bot.switchingTo ?? bot.threadId;
  const task = bot.tasks?.find((candidate) => candidate.threadId === shown);
  return Boolean(task ? task.unread : bot.unread);
}
