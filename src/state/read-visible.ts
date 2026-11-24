import { botShowsUnread } from "@/lib/bot-unread";
import type { AppState, BotAnnouncement, Group } from "./store";
import { serverFetch } from "@/lib/relay-server";

type SendRead = (path: string, threadId: string, updatedAt: number) => void;
const sendRead: SendRead = (path, threadId) => {
  void serverFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId }) }).catch(() => {});
};

function visibleThreadIds(state: AppState, kind: "bot" | "group", ownerId: string, shown?: string): string[] {
  const panel = state.forkPanel;
  const split = Object.values(state.workspacePanes?.panels ?? {}).filter((pane) => pane.kind === kind && pane.ownerId === ownerId);
  return [...new Set([shown, ...split.map((pane) => pane.threadId), panel?.kind === kind && panel.ownerId === ownerId ? panel.threadId : undefined])]
    .filter((threadId): threadId is string => Boolean(threadId));
}

export function markVisibleBotThreadsRead(state: AppState, bot: BotAnnouncement, focused: boolean, post: SendRead = sendRead): void {
  if (state.activeView !== "chat" || !focused) return;
  const selected = state.bots.find((candidate) => candidate.id === bot.id);
  const shown = bot.id === state.selectedId ? selected?.switchingTo ?? selected?.threadId : undefined;
  const visibleThreads = visibleThreadIds(state, "bot", bot.id, shown);
  if (!visibleThreads.length) return;
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
  if (state.activeView !== "chat" || !focused) return;
  const shown = group.id === state.selectedId ? state.groups.find((candidate) => candidate.id === group.id)?.threadId : undefined;
  const visibleThreads = visibleThreadIds(state, "group", group.id, shown);
  if (!visibleThreads.length) return;
  for (const threadId of visibleThreads) {
    const task = group.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!task?.unread && (group.tasks || !group.unread)) continue;
    if (task) task.unread = false;
    post(`/api/groups/${group.id}/read`, threadId, task?.updatedAt ?? 0);
  }
  group.unread = group.tasks ? group.tasks.some((task) => task.unread) : false;
}
