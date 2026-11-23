interface MainThreadCandidate {
  threadId: string;
  createdAt: number;
  archivedAt?: number;
  routineRunId?: string;
  /** Set when a bot opened the thread: a hand-off, a burst lane, its own side job. */
  openedBy?: object;
}

export function oldestThread(tasks: readonly MainThreadCandidate[]): string | undefined {
  const visible = tasks.filter((task) => !task.routineRunId);
  const open = visible.filter((task) => task.archivedAt === undefined);
  return (open.length ? open : visible).reduce<MainThreadCandidate | undefined>(
    (oldest, task) => (!oldest || task.createdAt < oldest.createdAt ? task : oldest), undefined,
  )?.threadId;
}

export function wasOldestThread(tasks: readonly MainThreadCandidate[], threadId: string): boolean {
  const saved = tasks.find((task) => task.threadId === threadId && !task.routineRunId);
  return saved !== undefined && !tasks.some((task) => !task.routineRunId && task.archivedAt === undefined && task.createdAt < saved.createdAt);
}

/** A bot's main thread, where it opens to with threads hidden and where its routines and briefs report: the one the
 * person chose (while it is open), else the oldest open conversation a person started, else the oldest open one. Writing
 * in another thread never moves it. */
export function mainThread(tasks: readonly MainThreadCandidate[], chosenId?: string): string | undefined {
  const chosen = chosenId ? tasks.find((task) => task.threadId === chosenId) : undefined;
  if (chosen && !chosen.routineRunId && chosen.archivedAt === undefined) return chosen.threadId;
  return oldestThread(tasks.filter((task) => !task.openedBy && task.archivedAt === undefined)) ?? oldestThread(tasks);
}

/** The conversation whose saves stay in the bot's own memory: the one the person set as main while it is open, else the
 * oldest, archived or not. Unlike mainThread it does not follow where the person last wrote, so a conversation's notes
 * keep their scope. */
export function memoryHomeThread(tasks: readonly MainThreadCandidate[], chosenId?: string): string | undefined {
  const conversations = tasks.filter((task) => !task.routineRunId);
  if (chosenId && conversations.some((task) => task.threadId === chosenId && task.archivedAt === undefined)) return chosenId;
  return conversations.reduce<MainThreadCandidate | undefined>((oldest, task) => (!oldest || task.createdAt < oldest.createdAt ? task : oldest), undefined)?.threadId;
}
