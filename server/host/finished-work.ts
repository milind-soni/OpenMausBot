// Work one bot hands a teammate is finished once its result is reported back: the thread it ran in closes, which folds
// it out of the sidebar, and the next turn in it opens it again.
import type { TaskRecord } from "../store.ts";

type FinishedTask = Pick<TaskRecord, "openedBy" | "closedBy" | "pinned" | "projectId" | "askedAt">;

/** Whether `task`, a thread of `ownerBotId` that `openerBotId` handed work to, closes now that the result is reported.
 * The standing work thread always does. A thread opened with coordinate_bots thread "new" does too, unless it was kept:
 * pinned, filed in a folder, or written in by a person. The pair conversation, a burst's part and a thread a bot opened on itself never do. */
export function closesOnResult(task: FinishedTask | undefined, openerBotId: string, ownerBotId: string): boolean {
  const openedBy = task?.openedBy;
  if (!task || !openedBy || task.closedBy || openedBy.botId !== openerBotId) return false;
  if (openedBy.kind === "work") return true;
  return openedBy.kind === undefined && ownerBotId !== openerBotId && !openedBy.burstId && !openedBy.roomLane
    && task.pinned !== true && task.projectId === undefined && task.askedAt === undefined;
}
