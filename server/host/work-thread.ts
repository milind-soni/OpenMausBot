import type { Store, TaskRecord } from "../store.ts";

/** Where coordinate_bots sends to a teammate outside a room, by its `thread`: "standing" is the sender conversation's one
 * work thread with that teammate (undefined until it is opened), "new" opens one (undefined), and any other value is the id
 * of a thread the sender opened on that teammate earlier. Throws when it is not one. `also` narrows which threads count. */
export function workThreadFor(store: Pick<Store, "workThread" | "taskByThread">, input: { botId: string; botName: string; fromBotId: string; fromThreadId: string;
  thread: string; also: (task: TaskRecord) => boolean }): TaskRecord | undefined {
  const { botId, thread, also } = input;
  if (thread === "new") return undefined;
  if (thread === "standing") return store.workThread(botId, input.fromBotId, input.fromThreadId, false, also);
  const task = store.taskByThread(botId, thread);
  if (task?.openedBy?.botId === input.fromBotId && !task.openedBy.roomLane && task.archivedAt === undefined && also(task)) return task;
  throw new Error(`"${thread}" is not a thread you opened on ${input.botName}: use a threadId one of your coordinate_bots receipts gave, or one list_threads shows on them`);
}
