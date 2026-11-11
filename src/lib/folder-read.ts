import type { Bot, BotAnnouncement, Group } from "@/state/store";

type FolderBot = Pick<Bot, "id" | "threadId" | "unread" | "tasks">;
type DepartmentBot = FolderBot & Pick<Bot, "section" | "hidden">;
type DepartmentGroup = Pick<Group, "id" | "unread" | "section" | "dm">;

export function botUnreadThreadIds(bot: FolderBot): string[] {
  if (!bot.tasks?.length) return bot.unread ? [bot.threadId] : [];
  return bot.tasks
    .filter((task) => task.unread ?? (task.threadId === bot.threadId && bot.unread))
    .map((task) => task.threadId);
}

export function folderUnreadThreadIds(bot: FolderBot, projectId: string): string[] {
  return (bot.tasks ?? [])
    .filter((task) => task.projectId === projectId && (task.unread ?? (task.threadId === bot.threadId && bot.unread)))
    .map((task) => task.threadId);
}

export async function markFolderRead(
  bot: FolderBot,
  projectId: string,
  request: (path: string, init?: RequestInit) => Promise<{ bot: BotAnnouncement }>,
  onRead: (bot: BotAnnouncement) => void,
): Promise<void> {
  await markThreadsRead(bot.id, folderUnreadThreadIds(bot, projectId), request, onRead);
}

export async function markBotRead(
  bot: FolderBot,
  request: (path: string, init?: RequestInit) => Promise<{ bot: BotAnnouncement }>,
  onRead: (bot: BotAnnouncement) => void,
): Promise<void> {
  await markThreadsRead(bot.id, botUnreadThreadIds(bot), request, onRead);
}

async function markThreadsRead(
  botId: string,
  threadIds: readonly string[],
  request: (path: string, init?: RequestInit) => Promise<{ bot: BotAnnouncement }>,
  onRead: (bot: BotAnnouncement) => void,
): Promise<void> {
  for (const threadId of threadIds) {
    const result = await request(`/api/bots/${botId}/read`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    });
    onRead(result.bot);
  }
}

/** What a department's "Mark all as read" covers: its shown bots, each with every conversation, and its group chats. */
export function departmentUnread(name: string, bots: readonly DepartmentBot[], groups: readonly DepartmentGroup[]): { bots: DepartmentBot[]; groups: DepartmentGroup[] } {
  return {
    bots: bots.filter((bot) => !bot.hidden && (bot.section?.trim() || "") === name && botUnreadThreadIds(bot).length > 0),
    groups: groups.filter((group) => !group.dm && group.section === name && group.unread),
  };
}

/** One request at a time, so a failure keeps every read before it. */
export async function markDepartmentRead(
  unread: { bots: readonly DepartmentBot[]; groups: readonly DepartmentGroup[] },
  request: (path: string, init?: RequestInit) => Promise<{ bot?: BotAnnouncement; group?: Partial<Group> & { id: string } }>,
  onBot: (bot: BotAnnouncement) => void,
  onGroup: (group: Partial<Group> & { id: string }) => void,
): Promise<void> {
  for (const bot of unread.bots) await markBotRead(bot, request as (path: string, init?: RequestInit) => Promise<{ bot: BotAnnouncement }>, onBot);
  for (const group of unread.groups) {
    const result = await request(`/api/groups/${group.id}/read`, { method: "POST" });
    if (result.group) onGroup(result.group);
  }
}
