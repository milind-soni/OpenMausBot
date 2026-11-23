import { botShowsUnread } from "@/lib/bot-unread";
import type { Action, AppState, BotAnnouncement, Group } from "./store";
import { serverFetch } from "@/lib/relay-server";

type SendRead = (path: string, threadId: string, updatedAt: number) => void;
const sendRead: SendRead = (path, threadId) => {
  void serverFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId }) }).catch(() => {});
};

/** Conversations the person marked unread while looking at them, with their newest message then (unknown until the
 * server next announces them). Being on screen reads none of them again until a newer message arrives. */
const markedUnread = new Map<string, number | undefined>();
const OPENS_A_CONVERSATION: ReadonlySet<Action["type"]> = new Set(["select", "openDataResult", "switchTask", "newTask", "send"]);

function shownBotThread(state: AppState): string | undefined {
  if (state.activeView !== "chat" || (state.newChat && state.newChat.botId === state.selectedId)) return undefined;
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
  return bot?.switchingTo ?? bot?.threadId;
}

/** "Mark as unread" on the open conversation holds while the person stays on it. It ends when they open a conversation,
 * this one included, write in one, or act from anywhere else in the app. */
export function holdMarkedUnread(action: Action, state: AppState): void {
  const shown = shownBotThread(state);
  if (OPENS_A_CONVERSATION.has(action.type) || !shown || !markedUnread.has(shown)) markedUnread.clear();
  if (action.type !== "markUnread" || action.botId !== state.selectedId || !shown) return;
  const bot = state.bots.find((candidate) => candidate.id === action.botId);
  markedUnread.set(shown, bot?.tasks?.find((task) => task.threadId === shown)?.updatedAt);
}

/** Whether the shown conversation is still held unread: marked by the person, and nothing newer has arrived in it. */
export function shownChatHeldUnread(state: AppState): boolean {
  const shown = shownBotThread(state);
  if (!shown || !markedUnread.has(shown)) return false;
  const marked = markedUnread.get(shown);
  const newest = state.bots.find((candidate) => candidate.id === state.selectedId)?.tasks?.find((task) => task.threadId === shown)?.updatedAt;
  return marked === undefined || newest === undefined || newest <= marked;
}

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
  let held = false;
  for (const threadId of visibleThreads) {
    const task = bot.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!task?.unread && (bot.tasks || !bot.unread)) continue;
    if (markedUnread.has(threadId)) {
      const newest = task?.updatedAt ?? 0, marked = markedUnread.get(threadId) ?? newest;
      if (newest <= marked) {
        markedUnread.set(threadId, marked);
        held = true;
        continue;
      }
      markedUnread.delete(threadId);
    }
    if (task) task.unread = false;
    post(`/api/bots/${bot.id}/read`, threadId, task?.updatedAt ?? 0);
  }
  if (bot.tasks) bot.unread = botShowsUnread(bot);
  else if (!held) bot.unread = false;
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
