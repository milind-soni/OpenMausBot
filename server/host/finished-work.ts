// Work one bot hands a teammate is finished once its result is reported back. The standing work thread closes, which folds
// it out of the sidebar. A thread coordinate_bots opened with thread "new" for that one hand-off (`openedBy.oneShot`) also
// closes, and leaves the sidebar for the archive. The next turn in either opens it again. Every other thread stays as it is.
import type { Store, TaskRecord } from "../store.ts";

type FinishedTask = Pick<TaskRecord, "openedBy" | "closedBy" | "pinned" | "projectId" | "askedAt">;

/** Whether `task`, a thread of `ownerBotId` that `openerBotId` handed work to, closes now that the result is reported.
 * The standing work thread always does. A one-shot thread does too, unless it was kept: pinned, filed in a folder, or
 * written in by a person. A thread start_thread opened, one a post_to_thread reached, the pair conversation, a burst's
 * part, a room lane and a thread a bot opened on itself never do. */
export function closesOnResult(task: FinishedTask | undefined, openerBotId: string, ownerBotId: string): boolean {
  const openedBy = task?.openedBy;
  if (!task || !openedBy || task.closedBy || openedBy.botId !== openerBotId) return false;
  if (openedBy.kind === "work") return true;
  return openedBy.oneShot === true && openedBy.kind === undefined && ownerBotId !== openerBotId && !openedBy.burstId && !openedBy.roomLane
    && task.pinned !== true && task.projectId === undefined && task.askedAt === undefined;
}

/** Whether a thread that just closed on its result is also archived: a one-shot thread is, unless it is unread or a wait
 * it set is still armed, since that wait's message lands there later. The standing work thread is not, so the opener's
 * next work goes on in it. */
export function archivesOnResult(task: Pick<TaskRecord, "openedBy" | "unread">, waitArmed: boolean): boolean {
  return task.openedBy?.oneShot === true && task.openedBy.kind === undefined && task.unread !== true && !waitArmed;
}

/** Whether a one-shot thread is in the archive because its result came back (`finishHandedThread` stamps the close and the
 * archive at the same moment), not because the person archived it. Only such a thread may be taken out of the archive. */
export function archivedOnResult(task: Pick<TaskRecord, "openedBy" | "closedBy" | "archivedAt">): boolean {
  return task.openedBy?.oneShot === true && task.archivedAt !== undefined
    && task.closedBy?.botId === task.openedBy.botId && task.closedBy.at === task.archivedAt;
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

/** A one-shot thread its opener sends to again leaves the archive its result put it in, so the person sees the work it
 * runs. A thread the person archived stays there. */
export function reopenHandedThread(store: Pick<Store, "patchTask">, ownerBotId: string, task: Pick<TaskRecord, "threadId" | "openedBy" | "closedBy" | "archivedAt">): void {
  if (archivedOnResult(task)) store.patchTask(ownerBotId, task.threadId, { archivedAt: undefined });
}

/** A post_to_thread reached this thread: bots go on writing in it, so it is no longer one hand-off's and stays open after a result. */
export function keepHandedThread(store: Pick<Store, "taskByThread" | "setTaskOpenedBy">, ownerBotId: string, threadId: string): void {
  const openedBy = store.taskByThread(ownerBotId, threadId)?.openedBy;
  if (!openedBy?.oneShot) return;
  const { oneShot: _oneShot, ...kept } = openedBy;
  store.setTaskOpenedBy(ownerBotId, threadId, kept);
}
