import type { Store, TaskRecord } from "../store.ts";

/** Where coordinate_bots sends to a teammate outside a room, by its `thread`: "standing" is the sender conversation's one
 * work thread with that teammate (undefined until it is opened), "new" opens one (undefined), and any other value is the id
 * of a thread the sender opened on that teammate earlier, or of the teammate's thread that handed the sender work: a
 * requester that asked with reply none hears back only there, so it takes a one-way notice (`notice`), never new work.
 * Throws when it is neither. `also` narrows which threads count. */
export function workThreadFor(store: Pick<Store, "workThread" | "taskByThread" | "tasks">, input: { botId: string; botName: string; fromBotId: string; fromThreadId: string;
  thread: string; notice: boolean; also: (task: TaskRecord) => boolean }): TaskRecord | undefined {
  const { botId, thread, also } = input;
  if (thread === "new") return undefined;
  if (thread === "standing") return store.workThread(botId, input.fromBotId, input.fromThreadId, false, also);
  const task = store.taskByThread(botId, thread);
  const usable = task !== undefined && task.archivedAt === undefined && also(task);
  if (usable && task.openedBy?.botId === input.fromBotId && !task.openedBy.roomLane) return task;
  const handedWork = usable && store.tasks(input.fromBotId).some((own) => own.openedBy?.botId === botId && own.openedBy.threadId === thread && !own.openedBy.roomLane);
  if (handedWork && input.notice) return task;
  if (handedWork) throw new Error(`"${thread}" handed you work: answer it there with reply "none", a one-way notice; it cannot be given new work`);
  throw new Error(`"${thread}" is not a thread you opened on ${input.botName}: use a threadId one of your coordinate_bots receipts gave, or one list_threads shows on them`);
}
