// Work one bot hands a teammate is finished once its result is reported back: the thread it ran in closes, which folds
// it out of the sidebar, and the next turn in it opens it again.
import type { Store, TaskRecord } from "../store.ts";

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

/** Whether a thread that just closed on its result is also archived: one opened with thread "new" is, unless it is
 * unread or a wait it set is still armed, since that wait's message lands there later. The standing work thread is not,
 * so the opener's next work goes on in it. */
export function archivesOnResult(task: Pick<TaskRecord, "openedBy" | "unread">, waitArmed: boolean): boolean {
  return task.openedBy !== undefined && task.openedBy.kind === undefined && task.unread !== true && !waitArmed;
}

type FinishStore = Pick<Store, "taskByThread" | "bot" | "setTaskClosedBy" | "patchTask">;

/** Closes, and archives where it should, the thread of `ownerBotId` that `openerBotId` handed work to, now that its result is reported. */
export function finishHandedThread(store: FinishStore, ownerBotId: string, threadId: string, openerBotId: string,
  waitArmed: (threadId: string) => boolean, now = Date.now()): void {
  const task = store.taskByThread(ownerBotId, threadId);
  if (!task || !closesOnResult(task, openerBotId, ownerBotId)) return;
  store.setTaskClosedBy(ownerBotId, threadId, { botId: openerBotId, name: store.bot(openerBotId)?.name ?? task.openedBy!.name, at: now });
  if (archivesOnResult(task, waitArmed(threadId))) store.patchTask(ownerBotId, threadId, { archivedAt: now });
}

/** A thread the opener sends to again leaves the archive, so the person sees the work it runs. */
export function reopenHandedThread(store: Pick<Store, "patchTask">, ownerBotId: string, task: Pick<TaskRecord, "threadId" | "archivedAt">): void {
  if (task.archivedAt !== undefined) store.patchTask(ownerBotId, task.threadId, { archivedAt: undefined });
}
