import { botShowsUnread } from "@/lib/bot-unread";
import type { AppState, BotAnnouncement, Group } from "./store";

type SendRead = (path: string, threadId: string) => void;
const sendRead: SendRead = (path, threadId) => {
  void fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId }) }).catch(() => {});
};

/** The main conversation and its side fork are both visible while the panel is open. */
export function markVisibleBotThreadsRead(state: AppState, bot: BotAnnouncement, focused: boolean, post: SendRead = sendRead): void {
  if (bot.id !== state.selectedId || state.activeView !== "chat" || !focused) return;
  const selected = state.bots.find((candidate) => candidate.id === bot.id);
  const shown = selected?.switchingTo ?? selected?.threadId;
  const panel = state.forkPanel;
  const visibleThreads = [...new Set([shown, panel?.kind === "bot" && panel.ownerId === bot.id ? panel.threadId : undefined])]
    .filter((threadId): threadId is string => Boolean(threadId));
  for (const threadId of visibleThreads) {
    const task = bot.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!task?.unread && (bot.tasks || !bot.unread)) continue;
    if (task) task.unread = false;
    post(`/api/bots/${bot.id}/read`, threadId);
  }
  bot.unread = bot.tasks ? botShowsUnread(bot) : false;
}

export function markVisibleGroupThreadsRead(state: AppState, group: Partial<Group> & { id: string }, focused: boolean,
  post: SendRead = sendRead): void {
  if (!group.unread || group.id !== state.selectedId || state.activeView !== "chat" || !focused) return;
  group.unread = false;
  const shown = state.groups.find((candidate) => candidate.id === group.id)?.threadId;
  const panel = state.forkPanel;
  const visibleThreads = [...new Set([shown, panel?.kind === "group" && panel.ownerId === group.id ? panel.threadId : undefined])]
    .filter((threadId): threadId is string => Boolean(threadId));
  for (const threadId of visibleThreads) post(`/api/groups/${group.id}/read`, threadId);
}
