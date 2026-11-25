import { botShowsUnread } from "@/lib/bot-unread";
import type { Action, AppState, BotAnnouncement, Group } from "./store";
import { serverFetch } from "@/lib/relay-server";
import { roomFeedShows } from "@/lib/room-feed";

/** "seen": only on screen, which a conversation the person marked unread with it open holds against; "open": the person
 * opened it again, which ends that mark. */
export type ReadReason = "seen" | "open";
type SendRead = (path: string, threadId: string, updatedAt: number, reason: ReadReason) => void;
const sendRead: SendRead = (path, threadId, _updatedAt, reason) => {
  void serverFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, reason }) }).catch(() => {});
};

/** Conversations the person marked unread in this page while looking at them, with their newest message then (unknown
 * until the server next announces them), until the server's own mark (`heldUnread`) reaches the page. */
const markedUnread = new Map<string, number | undefined>();
/** Conversations the server holds unread that the person opened again here, read once their mark is next announced. */
const reopened = new Set<string>();
const OPENS_A_CONVERSATION: ReadonlySet<Action["type"]> = new Set(["select", "openDataResult", "switchTask", "newTask", "send"]);

function shownBotThread(state: AppState): string | undefined {
  if (state.activeView !== "chat" || (state.newChat && state.newChat.botId === state.selectedId)) return undefined;
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
  return bot?.switchingTo ?? bot?.threadId;
}

/** The conversation an action puts on screen or writes in, which the person chose; never one merely shown beside it. */
function openedBotThread(action: Action, state: AppState): string | undefined {
  if ((action.type === "switchTask" || action.type === "send") && action.threadId) return action.threadId;
  const botId = action.type === "select" ? action.id : action.type === "openDataResult" || action.type === "send" ? action.botId : undefined;
  const bot = botId === undefined ? undefined : state.bots.find((candidate) => candidate.id === botId);
  return bot?.switchingTo ?? bot?.threadId;
}

/** "Mark as unread" on the open conversation holds while the person stays on it. It ends when they open a conversation,
 * this one included, write in one, or act from anywhere else in the app. The server's own mark ends only for the
 * conversation they open or write in. */
export function holdMarkedUnread(action: Action, state: AppState): void {
  const shown = shownBotThread(state), leaves = OPENS_A_CONVERSATION.has(action.type) || !shown;
  if (leaves || !markedUnread.has(shown)) markedUnread.clear();
  const opened = OPENS_A_CONVERSATION.has(action.type) ? openedBotThread(action, state) : undefined;
  if (opened && state.bots.some((bot) => bot.tasks?.some((task) => task.threadId === opened && task.heldUnread !== undefined))) reopened.add(opened);
  if (action.type !== "markUnread" || action.botId !== state.selectedId || !shown) return;
  const bot = state.bots.find((candidate) => candidate.id === action.botId);
  markedUnread.set(shown, bot?.tasks?.find((task) => task.threadId === shown)?.updatedAt);
  reopened.delete(shown);
}

const serverHolds = (task: { threadId: string; heldUnread?: string } | undefined) =>
  task?.heldUnread !== undefined && !reopened.has(task.threadId);

/** Whether the shown conversation is still held unread: marked by the person, and nothing newer has arrived in it. */
export function shownChatHeldUnread(state: AppState): boolean {
  const shown = shownBotThread(state);
  if (!shown) return false;
  const task = state.bots.find((candidate) => candidate.id === state.selectedId)?.tasks?.find((candidate) => candidate.threadId === shown);
  if (serverHolds(task)) return true;
  if (!markedUnread.has(shown)) return false;
  const marked = markedUnread.get(shown), newest = task?.updatedAt;
  return marked === undefined || newest === undefined || newest <= marked;
}

/** Whether the thread panel holds one of this owner's threads: it is on screen beside whatever the chat shows. */
const panelHolds = (state: AppState, kind: "bot" | "group", ownerId: string) => state.forkPanel?.kind === kind && state.forkPanel.ownerId === ownerId;
const chatShows = (state: AppState, id: string) => id === state.selectedId && state.activeView === "chat";

function visibleThreadIds(state: AppState, kind: "bot" | "group", ownerId: string, shown?: string): string[] {
  const panel = state.forkPanel;
  return [...new Set([shown, panel?.kind === kind && panel.ownerId === ownerId ? panel.threadId : undefined])]
    .filter((threadId): threadId is string => Boolean(threadId));
}

export function markVisibleBotThreadsRead(state: AppState, bot: BotAnnouncement, focused: boolean, post: SendRead = sendRead): void {
  if (!focused || !(chatShows(state, bot.id) || panelHolds(state, "bot", bot.id))) return;
  const selected = chatShows(state, bot.id) ? state.bots.find((candidate) => candidate.id === bot.id) : undefined;
  const shown = selected?.switchingTo ?? selected?.threadId;
  const visibleThreads = visibleThreadIds(state, "bot", bot.id, shown);
  if (visibleThreads.length === 0) return;
  let held = false;
  for (const threadId of visibleThreads) {
    const task = bot.tasks?.find((candidate) => candidate.threadId === threadId);
    if (task && task.heldUnread === undefined) reopened.delete(threadId);
    if (!task?.unread && (bot.tasks || !bot.unread || threadId !== shown)) continue;
    if (serverHolds(task)) {
      held = true;
      continue;
    }
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
    post(`/api/bots/${bot.id}/read`, threadId, task?.updatedAt ?? 0, task?.heldUnread !== undefined ? "open" : "seen");
  }
  if (bot.tasks) bot.unread = botShowsUnread(bot);
  else if (!held && shown) bot.unread = false;
}

export function markVisibleGroupThreadsRead(state: AppState, group: Partial<Group> & { id: string }, focused: boolean,
  post: SendRead = sendRead): void {
  if (!focused || !(chatShows(state, group.id) || panelHolds(state, "group", group.id))) return;
  const room = chatShows(state, group.id) ? state.groups.find((candidate) => candidate.id === group.id) : undefined;
  const shown = room && !roomFeedShows(state.config, room) ? room.threadId : undefined;
  const visibleThreads = visibleThreadIds(state, "group", group.id, shown);
  if (visibleThreads.length === 0) return;
  for (const threadId of visibleThreads) {
    const task = group.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!task?.unread && (group.tasks || !group.unread || threadId !== shown)) continue;
    if (task) task.unread = false;
    post(`/api/groups/${group.id}/read`, threadId, task?.updatedAt ?? 0, "seen");
  }
  if (group.tasks) group.unread = group.tasks.some((task) => task.unread);
  else if (shown) group.unread = false;
}
