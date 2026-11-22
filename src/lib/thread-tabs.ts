import type { Task } from "@/state/store";
import { isNewChatThread } from "@/state/new-chat";

export type TabThread = Pick<Task, "threadId" | "title" | "createdAt" | "routineRunId" | "openedBy" | "closedBy" | "archivedAt" | "sharedChat">;

export interface ThreadTab {
  threadId: string;
  title: string;
  main: boolean;
  /** The blank "New thread" tab: no thread exists until the first send. */
  blank: boolean;
  /** Started by a routine, by the bot itself or by a teammate: hiding it only closes it on this device. */
  auto: boolean;
}

export interface ThreadTabsModel {
  /** False when the bot has one chat and nothing hidden: the chat looks as it always has. */
  shown: boolean;
  tabs: ThreadTab[];
  selected: string;
  mainId: string;
  yours: { task: TabThread; open: boolean }[];
  auto: TabThread[];
}

/** A routine run, a thread a bot opened (its own `start_thread` or burst, or a teammate's hand-off). */
export const startedOnItsOwn = (task: Pick<TabThread, "routineRunId" | "openedBy">): boolean => Boolean(task.routineRunId || task.openedBy);

/** Present, not truthy: a thread stored with archivedAt: 0 is hidden too. */
const hidden = (task: Pick<TabThread, "archivedAt">): boolean => task.archivedAt !== undefined;

/** The bot's main chat: its oldest thread the person started. It never moves, whichever tab was written in last. */
export function mainTabThread(tasks: readonly TabThread[], fallback: string): string {
  const own = tasks.filter((task) => !startedOnItsOwn(task));
  const pool = own.length ? own : tasks;
  return pool.reduce<TabThread | undefined>((oldest, task) => (!oldest || task.createdAt < oldest.createdAt ? task : oldest), undefined)?.threadId ?? fallback;
}

/** The tab row for one bot. `opened`: the started-on-its-own threads the person opened as tabs on this device. */
export function threadTabsModel(
  bot: { threadId: string; switchingTo?: string; tasks?: readonly TabThread[] },
  opened: ReadonlySet<string>,
): ThreadTabsModel {
  const tasks = bot.tasks ?? [];
  const blank = isNewChatThread(bot.threadId);
  const selected = blank ? bot.threadId : bot.switchingTo ?? bot.threadId;
  const mainId = mainTabThread(tasks, blank ? "" : bot.threadId);
  const isOpen = (task: TabThread): boolean => task.threadId === mainId
    || (startedOnItsOwn(task) ? opened.has(task.threadId) && !hidden(task) && !task.closedBy : !hidden(task));
  const byAge = (a: TabThread, b: TabThread) => Number(b.threadId === mainId) - Number(a.threadId === mainId) || a.createdAt - b.createdAt;
  const open = tasks.filter((task) => isOpen(task) || task.threadId === selected).sort(byAge);
  const tabs: ThreadTab[] = open.map((task) => ({
    threadId: task.threadId, title: task.title, main: task.threadId === mainId, blank: false, auto: startedOnItsOwn(task),
  }));
  if (blank) tabs.push({ threadId: bot.threadId, title: "", main: false, blank: true, auto: false });
  const yours = tasks.filter((task) => !startedOnItsOwn(task)).sort(byAge).map((task) => ({ task, open: isOpen(task) }));
  const auto = tasks.filter(startedOnItsOwn).sort((a, b) => b.createdAt - a.createdAt);
  return {
    shown: tabs.length >= 2 || yours.some((row) => !row.open),
    tabs, selected, mainId, yours, auto,
  };
}

export function neighbourTab(tabs: readonly ThreadTab[], threadId: string): ThreadTab | undefined {
  const at = tabs.findIndex((tab) => tab.threadId === threadId);
  if (at < 0) return undefined;
  return tabs[at - 1] ?? tabs[at + 1];
}
