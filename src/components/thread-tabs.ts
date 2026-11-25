import type { Bot, Task } from "@/state/store";
import type { NewChat } from "@/state/new-chat";
import { isNewChatThread, newChatThreadId } from "@/state/new-chat";
import { ownThread } from "./sidebar-thread-labels";
import { isArchived, isSnoozed, isWorking, orderedThreadList } from "./SidebarThreadRow";

export interface ThreadTab {
  threadId: string;
  title: string;
  pinned: boolean;
  working: boolean;
  /** The blank New thread chat, which has no thread yet. */
  draft: boolean;
  closable: boolean;
  renamable: boolean;
}

export type TabsBot = Pick<Bot, "id" | "threadId"> & Partial<Pick<Bot, "mainThreadId" | "tasks" | "busy" | "switchingTo">>;

/** The open thread: where a switch is going, or the blank New thread chat. */
export const openTabId = (bot: Pick<Bot, "threadId" | "switchingTo">): string => bot.switchingTo ?? bot.threadId;

const tabbed = (task: Task, open: string) =>
  task.threadId === open || task.pinned === true || (ownThread(task) && !isArchived(task) && !isSnoozed(task) && !task.closedBy);

/**
 * A bot's threads as tabs, in its sidebar order: pinned first, then by recent use. The blank New thread chat sits where
 * its thread will land once the first message makes it, after the pinned ones.
 */
export function threadTabs(bot: TabsBot): ThreadTab[] {
  const open = openTabId({ threadId: bot.threadId, switchingTo: bot.switchingTo });
  const tasks = orderedThreadList((bot.tasks ?? []).filter((task) => tabbed(task, open)));
  const main = bot.mainThreadId;
  const real = tasks.length;
  const tabs: ThreadTab[] = tasks.map((task) => {
    const working = isWorking(task) || (task.threadId === bot.threadId && Boolean(bot.busy));
    return {
      threadId: task.threadId, title: task.title, pinned: task.pinned === true, working, draft: false,
      closable: real > 1 && task.threadId !== main && !task.sharedChat && !working,
      renamable: !task.sharedChat,
    };
  });
  if (isNewChatThread(open)) {
    const at = tabs.findIndex((tab) => !tab.pinned);
    const draft: ThreadTab = { threadId: open, title: "", pinned: false, working: false, draft: true, closable: true, renamable: false };
    tabs.splice(at < 0 ? tabs.length : at, 0, draft);
  }
  return tabs;
}

const sameTab = (a: ThreadTab, b: ThreadTab) => a.threadId === b.threadId && a.title === b.title && a.pinned === b.pinned
  && a.working === b.working && a.draft === b.draft && a.closable === b.closable && a.renamable === b.renamable;

/** Whether two strips draw the same tabs in the same order. */
export function sameTabs(a: readonly ThreadTab[], b: readonly ThreadTab[]): boolean {
  return a === b || (a.length === b.length && a.every((tab, i) => sameTab(tab, b[i]!)));
}

/** The strip shows for a bot with two threads or more, its blank New thread chat counted. */
export const showsTabs = (tabs: readonly ThreadTab[]): boolean => tabs.length > 1;

/** Where closing a tab goes when it was the open one: the tab after it, else the one before. */
export function neighbourOf(tabs: readonly ThreadTab[], threadId: string): string | undefined {
  const at = tabs.findIndex((tab) => tab.threadId === threadId);
  if (at < 0) return undefined;
  return (tabs[at + 1] ?? tabs[at - 1])?.threadId;
}

/** Whether the strip shows for this bot in the chat: the header's New thread plus gives way to the strip's own. */
export function botShowsTabs(bot: TabsBot | undefined, newChat: NewChat | null | undefined): boolean {
  if (!bot) return false;
  const shown = newChat?.botId === bot.id ? { ...bot, threadId: newChatThreadId(bot.id), switchingTo: undefined } : bot;
  return showsTabs(threadTabs(shown));
}
