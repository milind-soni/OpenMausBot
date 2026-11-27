// The server announces every change to a bot task with a `{ kind: "bot-task", taskId }` frame. The store only passes the
// id on here; the open task list and the open task reload themselves. Kept apart from bot-tasks.ts so the main bundle,
// which the store is part of, does not pull in the lazily loaded task screens' helpers.
type Listener = (taskId: string) => void;

const listeners = new Set<Listener>();

export function announceBotTask(taskId: string): void {
  for (const listener of listeners) listener(taskId);
}

/** Calls `listener` with the id of every task that changes until the returned function is called. */
export function onBotTaskChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
