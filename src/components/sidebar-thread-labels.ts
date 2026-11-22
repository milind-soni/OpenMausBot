import type { Bot, Task } from "@/state/store";
import { botOpensTo } from "@/state/thread-navigation";
import { runningRoutineRuns, sidebarBotActivityTasks } from "./SidebarBotActivity";
import { isArchived, isSnoozed, isWorking, threadRecency } from "./SidebarThreadRow";

export const ACTIVE_DAYS = 7;
export const ACTIVE_LIMIT = 4;
export const RUNNING_LIMIT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type LabelStatus = "waiting" | "working" | "teammate" | "queued" | "unread" | null;
export type LabelTask = Task & { queued?: boolean };
export interface LabelRow { task: LabelTask; status: LabelStatus; current: boolean; main: boolean }
export interface ThreadLabels { rows: LabelRow[]; more: number; runningMore: number }

type LabelBot = Pick<Bot, "threadId"> & Partial<Pick<Bot, "mainThreadId" | "tasks" | "busy" | "activity" | "unread" | "waitingForTeammates">>;

/** The person started it: not a routine run, and not opened by a bot (its own new thread, a burst or a hand-off). */
export const ownThread = (task: Pick<Task, "routineRunId" | "openedBy">): boolean => !task.routineRunId && !task.openedBy;

const ownOpen = (bot: Pick<LabelBot, "tasks">) => (bot.tasks ?? []).filter((task) => ownThread(task) && !isArchived(task) && !isSnoozed(task));

/** Only a bot with more than one thread of the person's own has anything to unfold. */
export const canUnfold = (bot: Pick<LabelBot, "tasks">): boolean => ownOpen(bot).length > 1;

export function labelStatus(task: LabelTask): LabelStatus {
  if (task.activity === "waiting-on-you") return "waiting";
  if (isWorking(task)) return "working";
  if (task.waitingForTeammates === true) return "teammate";
  if (task.queued) return "queued";
  return task.unread ? "unread" : null;
}

/** Beyond `RUNNING_LIMIT` working threads, the rest are counted, not listed. */
function capRunning(tasks: LabelTask[]): { kept: LabelTask[]; runningMore: number } {
  let running = 0, runningMore = 0;
  const kept = tasks.filter((task) => {
    if (labelStatus(task) !== "working") return true;
    running += 1;
    if (running <= RUNNING_LIMIT) return true;
    runningMore += 1;
    return false;
  });
  return { kept, runningMore };
}

/**
 * The rows under a bot in Simple mode's sidebar. Folded: its threads that are working, wait on the person or have an
 * unread reply, except the one its row opens. Unfolded: also its active threads of the person's own (the open one, any
 * still going, and those used in the last week), at most `ACTIVE_LIMIT`, and how many more the bot panel lists.
 */
export function threadLabels(
  bot: LabelBot,
  queued: Record<string, unknown[]>,
  { unfolded, current, rowThreadId, now }: { unfolded: boolean; current?: string; rowThreadId: string; now: number },
): ThreadLabels {
  const main = botOpensTo(bot, false);
  const attention: LabelTask[] = [...sidebarBotActivityTasks(bot as Bot, queued), ...runningRoutineRuns(bot as Bot)];
  const row = (task: LabelTask): LabelRow => ({ task, status: labelStatus(task), current: task.threadId === current, main: task.threadId === main });
  if (!unfolded) {
    const { kept, runningMore } = capRunning(attention.filter((task) => task.threadId !== rowThreadId));
    return { rows: kept.map(row), more: 0, runningMore };
  }
  const own = ownOpen(bot).map((task) => ({ ...task, queued: Boolean(queued[task.threadId]?.length) }));
  const recent = (task: LabelTask) => now - threadRecency(task) < ACTIVE_DAYS * DAY_MS;
  const active = own.filter((task) => task.threadId === current || labelStatus(task) !== null || recent(task))
    .sort((a, b) => threadRecency(b) - threadRecency(a));
  let shown = active.slice(0, ACTIVE_LIMIT);
  const open = active.find((task) => task.threadId === current);
  if (open && !shown.includes(open)) shown = [...shown.slice(0, ACTIVE_LIMIT - 1), open];
  const listed = new Set(shown.map((task) => task.threadId));
  const { kept, runningMore } = capRunning([...shown, ...attention.filter((task) => !listed.has(task.threadId))]);
  const rows = new Set(kept.map((task) => task.threadId));
  return { rows: kept.map(row), more: own.filter((task) => !rows.has(task.threadId)).length, runningMore };
}
