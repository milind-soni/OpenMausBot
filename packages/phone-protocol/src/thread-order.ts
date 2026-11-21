import type { WireTask } from "./wire.ts";

export function orderedThreadList<T extends { pinned?: boolean; lastThreadOrderAt?: number; createdAt?: number }>(tasks: readonly T[]): T[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      const pin = Number(b.task.pinned === true) - Number(a.task.pinned === true);
      if (pin) return pin;
      const recency = (b.task.lastThreadOrderAt ?? b.task.createdAt ?? 0) - (a.task.lastThreadOrderAt ?? a.task.createdAt ?? 0);
      if (recency) return recency;
      return a.index - b.index;
    })
    .map((entry) => entry.task);
}

/** 0 is the "until new activity" sentinel. The event stream never drops an expired snooze, so check the clock too. */
export const isSnoozed = (task: Pick<WireTask, "snoozedUntil">, now = Date.now()): boolean =>
  task.snoozedUntil !== undefined && (task.snoozedUntil === 0 || task.snoozedUntil > now);

type OpenThreadCandidate = Pick<WireTask, "routineRunId" | "archivedAt" | "closedBy" | "openedBy" | "snoozedUntil" | "pinned" | "lastThreadOrderAt" | "createdAt">;

/** The top row of the bot's thread list, so deleting the open thread never pulls a hidden one into view. */
export function nextOpenThread<T extends OpenThreadCandidate>(tasks: readonly T[], now = Date.now()): T | undefined {
  const own = tasks.filter((task) => !task.routineRunId);
  const open = own.filter((task) => task.archivedAt === undefined);
  const listed = open.filter((task) => task.pinned === true || !(task.closedBy || task.openedBy || isSnoozed(task, now)));
  return [listed, open, own].map((candidates) => orderedThreadList(candidates)[0]).find((task) => task !== undefined);
}
