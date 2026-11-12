import { botShowsUnread } from "@/lib/bot-unread";
import type { AppState, BotAnnouncement, Group } from "./store";

type SendRead = (path: string, threadId: string, updatedAt: number) => void;
const sendRead: SendRead = (path, threadId) => {
  void fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId }) }).catch(() => {});
};

function visibleThreadIds(state: AppState, kind: "bot" | "group", ownerId: string, shown?: string): string[] {
  const panel = state.forkPanel;
  return [...new Set([shown, panel?.kind === kind && panel.ownerId === ownerId ? panel.threadId : undefined])]
    .filter((threadId): threadId is string => Boolean(threadId));
}

export function markVisibleBotThreadsRead(state: AppState, bot: BotAnnouncement, focused: boolean, post: SendRead = sendRead): void {
  if (bot.id !== state.selectedId || state.activeView !== "chat" || !focused) return;
  const selected = state.bots.find((candidate) => candidate.id === bot.id);
  const shown = selected?.switchingTo ?? selected?.threadId;
  const visibleThreads = visibleThreadIds(state, "bot", bot.id, shown);
  for (const threadId of visibleThreads) {
    const task = bot.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!task?.unread && (bot.tasks || !bot.unread)) continue;
    if (task) task.unread = false;
    post(`/api/bots/${bot.id}/read`, threadId, task?.updatedAt ?? 0);
  }
  bot.unread = bot.tasks ? botShowsUnread(bot) : false;
}

export function markVisibleGroupThreadsRead(state: AppState, group: Partial<Group> & { id: string }, focused: boolean,
  post: SendRead = sendRead): void {
  if (group.id !== state.selectedId || state.activeView !== "chat" || !focused) return;
  const shown = state.groups.find((candidate) => candidate.id === group.id)?.threadId;
  const visibleThreads = visibleThreadIds(state, "group", group.id, shown);
  for (const threadId of visibleThreads) {
    const task = group.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!task?.unread && (group.tasks || !group.unread)) continue;
    if (task) task.unread = false;
    post(`/api/groups/${group.id}/read`, threadId, task?.updatedAt ?? 0);
  }
  group.unread = group.tasks ? group.tasks.some((task) => task.unread) : false;
}
