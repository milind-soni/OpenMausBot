// Work one bot hands a teammate is finished once its result is reported back, whether it was done, failed or was stopped.
// The standing work thread closes, which folds it out of the sidebar. A thread coordinate_bots opened with thread "new" for
// that one hand-off (`openedBy.oneShot`) also closes, and leaves the sidebar for the archive. The person's Stop closes it
// only an hour later, so a stop by mistake can be taken back by writing there. A new message reopens it. Every other
// thread stays as it is.
import type { HandoffView } from "../coordinator.ts";
import { STOPPED_BY_USER, STOPPED_WITH_REQUEST } from "../runtime/types.ts";
import type { Message, Store, TaskRecord } from "../store.ts";

/** How long a thread whose work the person stopped stays open before it closes. */
export const STOP_GRACE_MS = 60 * 60_000;

type FinishedTask = Pick<TaskRecord, "openedBy" | "closedBy" | "pinned" | "projectId">;

/** Whether `task`, a thread of `ownerBotId` that `openerBotId` handed work to, closes now that the result is reported.
 * The standing work thread always does. A one-shot thread does too, unless the person kept it: pinned or filed in a
 * folder. A thread start_thread opened, the pair conversation, a burst's part, a room lane and a thread a bot opened on
 * itself never do. */
export function closesOnResult(task: FinishedTask | undefined, openerBotId: string, ownerBotId: string): boolean {
  const openedBy = task?.openedBy;
  if (!task || !openedBy || task.closedBy || openedBy.botId !== openerBotId) return false;
  if (openedBy.kind === "work") return true;
  return openedBy.oneShot === true && openedBy.kind === undefined && ownerBotId !== openerBotId && !openedBy.burstId && !openedBy.roomLane
    && task.pinned !== true && task.projectId === undefined;
}

/** Whether a thread that just closed on its result is also archived: a one-shot thread is, unless something there waits on
 * the person (it is unread, its bot asks them something, or a wait it set is still armed and its message lands there
 * later). The standing work thread is not, so the opener's next work goes on in it. */
export function archivesOnResult(task: Pick<TaskRecord, "openedBy" | "unread" | "activity">, waitArmed: boolean): boolean {
  return task.openedBy?.oneShot === true && task.openedBy.kind === undefined && task.unread !== true
    && task.activity !== "waiting-on-you" && !waitArmed;
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

/** Whether handed-off work ended on the person's Stop: in its own thread, or in the conversation that handed it on. A stop
 * the system made (a restart, a deleted conversation) or its requester made carries another cause. */
export function stoppedByPerson(child: Pick<HandoffView, "status" | "outcome" | "outcomeDetail">, parent?: Pick<HandoffView, "outcomeDetail">): boolean {
  if (child.status !== "cancelled" || child.outcome !== "stopped") return false;
  return child.outcomeDetail === STOPPED_BY_USER || (child.outcomeDetail === STOPPED_WITH_REQUEST && parent?.outcomeDetail === STOPPED_BY_USER);
}

/** A message that brings a closed hand-off thread back: the person writing, a bot posting into it, or new work handed there.
 * The lines a run leaves on its way out are not. */
export function opensAgain(message: Pick<Message, "role" | "threadPost" | "roomRequest">): boolean {
  return message.role === "user" || message.threadPost !== undefined || message.roomRequest?.phase === "request";
}

export interface HandedCloseDeps {
  store: FinishStore & Pick<Store, "bots" | "botByThread" | "setTaskOpenedBy" | "onChange">;
  /** Handed-off work is still live in the thread: queued, running, or parked on a question. */
  working(threadId: string): boolean;
  /** A wait `botId` set in the thread is still armed. */
  waitArmed(botId: string, threadId: string): boolean;
  now?: () => number;
}

/** Closes hand-off threads as their work ends, and the ones the person stopped once `STOP_GRACE_MS` passes with nothing
 * new written there. The deadline is kept on the thread (`openedBy.closesAt`), so a restart picks it up. */
export function createHandedClose(deps: HandedCloseDeps): { ended(child: HandoffView, parent: HandoffView, problem: boolean): void; dispose(): void } {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadlines = () => store.bots.flatMap((bot) => (bot.tasks ?? []).filter((task) => task.openedBy?.closesAt !== undefined).map((task) => ({ botId: bot.id, task })));
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const next = Math.min(...deadlines().map(({ task }) => task.openedBy!.closesAt!));
    if (!Number.isFinite(next)) return;
    timer = setTimeout(due, Math.max(0, next - now()));
    timer.unref?.();
  };
  const clear = (botId: string, task: TaskRecord) => {
    const { closesAt: _closesAt, ...openedBy } = task.openedBy!;
    store.setTaskOpenedBy(botId, task.threadId, openedBy);
  };
  const finish = (botId: string, threadId: string, openerBotId: string) =>
    finishHandedThread(store, botId, threadId, openerBotId, (id) => deps.waitArmed(botId, id), now());
  const due = () => {
    timer = undefined;
    const at = now();
    for (const { botId, task } of deadlines()) {
      if (task.openedBy!.closesAt! > at) continue;
      clear(botId, task);
      if (!deps.working(task.threadId) && task.activity !== "working") finish(botId, task.threadId, task.openedBy!.botId);
    }
    arm();
  };

  const unsubscribe = store.onChange((change) => {
    if (change.type !== "message" || !opensAgain(change.message)) return;
    const botId = store.botByThread(change.threadId)?.id;
    const task = botId ? store.taskByThread(botId, change.threadId) : undefined;
    if (!botId || !task) return;
    if (task.openedBy?.closesAt !== undefined) { clear(botId, task); arm(); }
    reopenHandedThread(store, botId, task);
  });
  arm();

  return {
    ended(child, parent, problem) {
      if (child.groupId || (child.status !== "completed" && child.status !== "failed" && child.status !== "cancelled")) return;
      if (child.status === "completed" && problem) return;
      if (!stoppedByPerson(child, parent)) {
        if (!deps.working(child.threadId)) finish(child.botId, child.threadId, parent.botId);
        return;
      }
      const task = store.taskByThread(child.botId, child.threadId);
      if (!task?.openedBy || !closesOnResult(task, parent.botId, child.botId)) return;
      store.setTaskOpenedBy(child.botId, child.threadId, { ...task.openedBy, closesAt: now() + STOP_GRACE_MS });
      arm();
    },
    dispose() {
      unsubscribe();
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
