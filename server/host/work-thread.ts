import type { Store, TaskRecord } from "../store.ts";
import { OUTSIDE_STAYS_HERE } from "./outside-lineage.ts";

/** Where coordinate_bots sends to a teammate outside a room, by its `thread`: "standing" is the sender conversation's one
 * work thread with that teammate (undefined until it is opened), "new" opens one (undefined), and any other value is the id
 * of a thread the sender opened on that teammate earlier, or `answering`: the requester of the sender's running assignment
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
  const usable = task !== undefined && task.archivedAt === undefined && also(task);
  if (input.any) {
    if (usable && !task.closedBy) return task;
    throw new Error(`"${thread}" is not an open thread of ${input.botName}: use a threadId list_threads shows on them`);
  }
  if (usable && task.openedBy?.botId === input.fromBotId && !task.openedBy.roomLane) return task;
  const handedWork = usable && input.answering?.botId === botId && input.answering.threadId === thread;
  if (handedWork && input.notice) return task;
  if (handedWork) throw new Error(`"${thread}" handed you work: answer it there with reply "none", a one-way notice; it cannot be given new work`);
  throw new Error(`"${thread}" is not a thread you opened on ${input.botName}: use a threadId one of your coordinate_bots receipts gave, or one list_threads shows on them`);
}
