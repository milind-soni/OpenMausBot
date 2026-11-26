// Work one bot hands a teammate is finished once its result is reported back, whether it was done, failed or was stopped.
// The standing work thread closes, which folds it out of the sidebar. A thread coordinate_bots opened with thread "new" for
// that one hand-off (`openedBy.oneShot`) is due to close, and closes into the archive once no bot works there and nothing
// there waits on the person. The person's Stop makes it due only an hour later, so a stop by mistake can be taken back by
// writing there. A new message takes the due close off, and brings a closed thread back. Every other thread stays as it is.
import type { HandoffView } from "../coordinator.ts";
import { STOPPED_BEFORE_RESUME, STOPPED_BEFORE_START, STOPPED_BY_USER, STOPPED_WITH_REQUEST, TURN_CUT } from "../runtime/types.ts";
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

/** Whether a one-shot thread may close into the archive now: nothing there waits on the person (it is unread, its bot asks
 * them something, or a wait it set is still armed and its message lands there later). The standing work thread never is
 * archived, so the opener's next work goes on in it. */
export function archivesOnResult(task: Pick<TaskRecord, "openedBy" | "unread" | "activity">, waitArmed: boolean): boolean {
  return task.openedBy?.oneShot === true && task.openedBy.kind === undefined && task.unread !== true
    && task.activity !== "waiting-on-you" && !waitArmed;
}

/** Whether a one-shot thread is in the archive because its work ended (the close and the archive are stamped at the same
 * moment), not because the person archived it. Only such a thread may be taken out of the archive. */
export function archivedOnResult(task: Pick<TaskRecord, "openedBy" | "closedBy" | "archivedAt">): boolean {
  return task.openedBy?.oneShot === true && task.archivedAt !== undefined
    && task.closedBy?.botId === task.openedBy.botId && task.closedBy.at === task.archivedAt;
}

type FinishStore = Pick<Store, "taskByThread" | "bot" | "setTaskClosedBy" | "patchTask">;

/** Closes the standing work thread `openerBotId` handed work to, now that its result is reported. A one-shot thread closes
 * through `createHandedClose`, which waits until nothing holds it. */
export function finishHandedThread(store: FinishStore, ownerBotId: string, threadId: string, openerBotId: string, now = Date.now()): void {
  const task = store.taskByThread(ownerBotId, threadId);
  if (!task || task.openedBy?.kind !== "work" || !closesOnResult(task, openerBotId, ownerBotId)) return;
  store.setTaskClosedBy(ownerBotId, threadId, { botId: openerBotId, name: store.bot(openerBotId)?.name ?? task.openedBy.name, at: now });
}

/** A one-shot thread a new message reaches leaves the archive its ended work put it in, and loses that close, so the person
 * sees the work it runs and it can close again when that ends. A thread the person archived stays there. */
export function reopenHandedThread(store: Pick<Store, "patchTask" | "setTaskClosedBy">, ownerBotId: string, task: Pick<TaskRecord, "threadId" | "openedBy" | "closedBy" | "archivedAt">): void {
  if (!archivedOnResult(task)) return;
  store.patchTask(ownerBotId, task.threadId, { archivedAt: undefined });
  store.setTaskClosedBy(ownerBotId, task.threadId, null);
}

/** The causes a stop leaves on work that only went down with the request it was for, so whose stop it was is that request's. */
const STOPPED_WITH_IT: readonly string[] = [STOPPED_WITH_REQUEST, STOPPED_BEFORE_START, STOPPED_BEFORE_RESUME];

/** Whether handed-off work ended on the person's Stop: in its own thread, or in a conversation up the line that handed it
 * on, the work that never started or was due to start again included. A stop the system made (a restart, a deleted
 * conversation, a turn that could not start) or its requester made carries another cause. `node` finds the requests above
 * `parent`. */
export function stoppedByPerson(
  child: Pick<HandoffView, "status" | "outcome" | "outcomeDetail">,
  parent?: Pick<HandoffView, "outcomeDetail" | "parentId">,
  node: (id: string) => Pick<HandoffView, "outcomeDetail" | "parentId"> | undefined = () => undefined,
): boolean {
  if (child.status !== "cancelled" || child.outcome !== "stopped") return false;
  let cause = child.outcomeDetail;
  let above = parent;
  for (let hops = 0; cause !== undefined && STOPPED_WITH_IT.includes(cause) && above && hops < 64; hops++) {
    cause = above.outcomeDetail;
    above = above.parentId ? node(above.parentId) : undefined;
  }
  return cause === STOPPED_BY_USER;
}

/** The causes the server gives the stops it makes itself, so none reads as the person's Stop. */
export const SYSTEM_STOP = {
  /** The bot was deleted, or its approval level was lowered in an emergency. */
  bot: "The bot's work was stopped by the server",
  /** The turn could not be started. */
  dispatch: "The turn could not start",
  /** The goal or routine run this turn served ended. */
  goal: "The goal this turn served ended",
  /** A coordinated turn's own abort: the stop under way, if any, else the system's cut (see stopAwaitingDirect). */
  turn: TURN_CUT,
} as const;

/** A message that brings a closed hand-off thread back: the person writing, a bot posting into it, or new work handed there.
 * The lines a run leaves on its way out are not. */
export function opensAgain(message: Pick<Message, "role" | "threadPost" | "roomRequest">): boolean {
  return message.role === "user" || message.threadPost !== undefined || message.roomRequest?.phase === "request";
}

export interface HandedCloseDeps {
  store: FinishStore & Pick<Store, "bots" | "botByThread" | "setTaskOpenedBy" | "onChange">;
  /** Handed-off work is still live in the thread: queued, running, or parked on a question. */
  working(threadId: string): boolean;
  /** A wait `botId` set in the thread is still armed, or ended and its message not yet there. */
  waitArmed(botId: string, threadId: string): boolean;
  /** The hand-off with that id, to read whose stop ended the work. */
  node?(id: string): Pick<HandoffView, "outcomeDetail" | "parentId"> | undefined;
  now?: () => number;
}

export interface HandedClose {
  ended(child: HandoffView, parent: HandoffView, problem: boolean): void;
  /** Something that held `botId`'s due threads, outside its threads, is gone: a wait it set fired, expired or was cancelled. */
  look(botId: string): void;
  dispose(): void;
}

/** Closes hand-off threads as their work ends. A one-shot thread is marked due (`openedBy.closesAt`: now, or an hour on for
 * the person's Stop) and closes into the archive once the moment has come, no bot works there and nothing waits on the
 * person. The standing work thread closes at once, or an hour after the person's Stop, once no bot works there. A change
 * to a due thread, its bot or its messages looks again, so a read, an answer, a decided card or a turn's end lets it
 * close; a wait going calls `look`. Only the due threads are looked at, kept in an index. The mark is kept on the thread,
 * so a restart picks it up. */
export function createHandedClose(deps: HandedCloseDeps): HandedClose {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let looking = false;
  // The host builds this before the coordinator `working` asks, so the first look waits for the boot to finish.
  let started = false;
  /** The due threads, by bot: `openedBy.closesAt` is set on each. Filled from the saved threads at boot. */
  const due = new Map<string, Set<string>>();
  const index = (botId: string, threadId: string, on: boolean) => {
    const threads = due.get(botId) ?? new Set<string>();
    if (on) threads.add(threadId); else threads.delete(threadId);
    if (threads.size) due.set(botId, threads); else due.delete(botId);
  };
  const dueTask = (botId: string, threadId: string) => {
    const task = store.taskByThread(botId, threadId);
    if (task?.openedBy?.closesAt !== undefined) return task;
    index(botId, threadId, false);
    return undefined;
  };

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const at = now();
    let next = Infinity;
    for (const [botId, threads] of due) {
      for (const threadId of threads) {
        const closesAt = dueTask(botId, threadId)?.openedBy!.closesAt;
        if (closesAt !== undefined && closesAt > at) next = Math.min(next, closesAt);
      }
    }
    if (!Number.isFinite(next)) return;
    timer = setTimeout(() => { timer = undefined; look(); arm(); }, next - at);
    timer.unref?.();
  };
  const unmark = (botId: string, task: TaskRecord) => {
    index(botId, task.threadId, false);
    const { closesAt: _closesAt, ...openedBy } = task.openedBy!;
    store.setTaskOpenedBy(botId, task.threadId, openedBy);
  };
  const busy = (task: TaskRecord) => deps.working(task.threadId) || task.busy === true || task.activity === "working";
  /** Closes each due thread nothing holds; one that no longer closes (the person pinned it, say) loses the mark. */
  const look = (botId?: string, threadId?: string) => {
    if (looking || !started) return;
    looking = true;
    try {
      const at = now();
      const owners = botId === undefined ? [...due.keys()] : [botId];
      for (const owner of owners) {
        for (const id of threadId === undefined ? [...due.get(owner) ?? []] : [threadId]) {
          const task = dueTask(owner, id);
          if (!task || task.openedBy!.closesAt! > at) continue;
          const opener = task.openedBy!.botId;
          if (!closesOnResult(task, opener, owner)) { unmark(owner, task); continue; }
          if (busy(task)) continue;
          if (task.openedBy!.kind === "work") {
            unmark(owner, task);
            finishHandedThread(store, owner, task.threadId, opener, at);
            continue;
          }
          if (!archivesOnResult(task, deps.waitArmed(owner, task.threadId))) continue;
          unmark(owner, task);
          store.setTaskClosedBy(owner, task.threadId, { botId: opener, name: store.bot(opener)?.name ?? task.openedBy!.name, at });
          store.patchTask(owner, task.threadId, { archivedAt: at });
        }
      }
    } finally { looking = false; }
  };
  const dueOwner = (threadId: string) => {
    for (const [botId, threads] of due) if (threads.has(threadId)) return botId;
    return undefined;
  };

  const unsubscribe = store.onChange((change) => {
    // A deleted bot's threads went with it, so its due ones leave the index.
    if (change.type === "bot.deleted") { due.delete(change.botId); arm(); return; }
    if (looking || !started) return;
    if (change.type === "bot") { if (due.has(change.botId)) look(change.botId, change.threadId !== undefined && due.get(change.botId)!.has(change.threadId) ? change.threadId : undefined); return; }
    if (change.type !== "message" && change.type !== "message.patch") return;
    if (change.type === "message" && opensAgain(change.message)) {
      const botId = store.botByThread(change.threadId)?.id;
      const task = botId ? store.taskByThread(botId, change.threadId) : undefined;
      if (!botId || !task) return;
      if (task.openedBy?.closesAt !== undefined) { unmark(botId, task); arm(); }
      reopenHandedThread(store, botId, task);
      return;
    }
    const owner = dueOwner(change.threadId);
    if (owner !== undefined) look(owner, change.threadId);
  });
  const boot = setTimeout(() => {
    for (const bot of store.bots) for (const task of bot.tasks ?? []) if (task.openedBy?.closesAt !== undefined) index(bot.id, task.threadId, true);
    started = true;
    look();
    arm();
  }, 0);
  boot.unref?.();

  return {
    ended(child, parent, problem) {
      if (child.groupId || (child.status !== "completed" && child.status !== "failed" && child.status !== "cancelled")) return;
      if (child.status === "completed" && problem) return;
      const task = store.taskByThread(child.botId, child.threadId);
      if (!task?.openedBy || !closesOnResult(task, parent.botId, child.botId)) return;
      const stopped = stoppedByPerson(child, parent, deps.node);
      if (task.openedBy.kind === "work" && !stopped) {
        if (!deps.working(child.threadId)) finishHandedThread(store, child.botId, child.threadId, parent.botId, now());
        return;
      }
      store.setTaskOpenedBy(child.botId, child.threadId, { ...task.openedBy, closesAt: now() + (stopped ? STOP_GRACE_MS : 0) });
      index(child.botId, child.threadId, true);
      look(child.botId, child.threadId);
      arm();
    },
    look(botId) { if (due.has(botId)) look(botId); },
    dispose() {
      unsubscribe();
      clearTimeout(boot);
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
