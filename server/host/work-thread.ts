import type { Store, TaskRecord } from "../store.ts";
import { archivedOnResult } from "./finished-work.ts";
import { OUTSIDE_STAYS_HERE } from "./outside-lineage.ts";

/** Where coordinate_bots sends to a teammate outside a room, by its `thread`: "standing" is the sender conversation's one
 * work thread with that teammate (undefined until it is opened), "new" opens one (undefined), and any other value is the id
 * of a thread the sender opened on that teammate earlier (archived only by its own result), or `answering`: the requester of the sender's running assignment
 * when it asked with reply none. Nothing returns from such work on its own, so it takes a one-way notice (`notice`) there,
 * never new work.
 * Throws when it is neither. `also` narrows which threads count. */
export function workThreadFor(store: Pick<Store, "workThread" | "taskByThread">, input: { botId: string; botName: string; fromBotId: string; fromThreadId: string;
  thread: string; notice: boolean; answering: { botId: string; threadId: string } | undefined; also: (task: TaskRecord) => boolean;
  /** Whether the sender's work may reach this thread at all; when it may not, it says so in its own words. */
  reach: (task: TaskRecord) => boolean;
  /** post_to_thread: any open thread of the bot, not only one the sender opened. */
  any?: boolean }): TaskRecord | undefined {
  const { botId, thread, also, reach } = input;
  if (thread === "new") return undefined;
  if (thread === "standing") return store.workThread(botId, input.fromBotId, input.fromThreadId, false, (task) => also(task) && reach(task));
  const task = store.taskByThread(botId, thread);
  if (task && !reach(task)) throw new Error(OUTSIDE_STAYS_HERE);
  const allowed = task !== undefined && also(task);
  const usable = allowed && task.archivedAt === undefined;
  const reusable = usable || (allowed && archivedOnResult(task));
  const yours = reusable && task.openedBy?.botId === input.fromBotId && !task.openedBy.roomLane;
  if (input.any) {
    if (usable && !task.closedBy) return task;
    const send = (to: string, what: string) => `coordinate_bots, e.g. {"bot_ids": [${JSON.stringify(input.botName)}], "thread": ${JSON.stringify(to)}, "message": "${what}"}`;
    if (yours) throw new Error(`"${thread}" is closed, and post_to_thread reaches only open threads. To carry on its subject with ${input.botName}, send it there with ${send(thread, "<what to carry on>")}: the thread opens again with its history`);
    if (task && allowed) throw new Error(`"${thread}" is not an open thread of ${input.botName}, and post_to_thread reaches only open threads. To carry on its subject, send it with ${send("standing", "<the subject and what to do>")}, or use a threadId list_threads shows open on them`);
    throw new Error(`"${thread}" is not an open thread of ${input.botName}: use a threadId list_threads shows on them`);
  }
  if (yours) return task;
  const handedWork = usable && input.answering?.botId === botId && input.answering.threadId === thread;
  if (handedWork && input.notice) return task;
  if (handedWork) throw new Error(`"${thread}" handed you work: answer it there with reply "none", a one-way notice; it cannot be given new work`);
  throw new Error(`"${thread}" is not a thread you opened on ${input.botName}: use a threadId one of your coordinate_bots receipts gave, or one list_threads shows on them`);
}

/** The thread a send to a teammate's standing work thread runs in. A thread holding work this turn already handed the
 * teammate, or work this conversation still waits on (`keeps`), takes it, so it runs after that work. Otherwise, while a
 * turn runs in the standing thread, the send takes another work thread this conversation opened on the teammate that holds
 * no work (`idle`), or undefined to open a new one, instead of waiting behind it. A teammate that could not start it anyway
 * (`full`) keeps the standing thread, where it queues as before. */
export function besideBusy(store: Pick<Store, "workThread">, standing: TaskRecord, input: { botId: string; fromBotId: string; fromThreadId: string;
  fits: (task: TaskRecord) => boolean; busy: (threadId: string) => boolean; idle: (threadId: string) => boolean; full: boolean;
  keeps: (threadId: string) => boolean }): TaskRecord | undefined {
  const pick = (more: (task: TaskRecord) => boolean) => store.workThread(input.botId, input.fromBotId, input.fromThreadId, false, (task) => input.fits(task) && more(task));
  return pick((task) => input.keeps(task.threadId)) ?? (input.full || !input.busy(standing.threadId) ? standing : pick((task) => input.idle(task.threadId)));
}
