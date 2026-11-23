interface MainThreadCandidate {
  threadId: string;
  createdAt: number;
  archivedAt?: number;
  routineRunId?: string;
  askedAt?: number;
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

const open = (task: MainThreadCandidate) => !task.routineRunId && task.archivedAt === undefined;

/** A bot's main thread, where it opens to with threads hidden and where its routines and briefs report: the one saved as
 * its choice (while it is open), else the oldest open conversation a person started, else the oldest open one. */
export function mainThread(tasks: readonly MainThreadCandidate[], chosenId?: string): string | undefined {
  if (chosenId && tasks.some((task) => task.threadId === chosenId && open(task))) return chosenId;
  return oldestThread(tasks.filter((task) => !task.openedBy && open(task))) ?? oldestThread(tasks);
}

/** The thread to save as a bot's choice so its main thread stays put: nothing while the saved one is open. A bot that
 * never had one keeps the thread it showed until now: the open one a person last wrote in, else the selected one, else
 * the oldest open one. One whose saved thread was archived or deleted moves to the oldest open conversation a person
 * started, else the oldest open one, and reopening the old one moves nothing. */
export function mainThreadToKeep(tasks: readonly MainThreadCandidate[], chosenId?: string, selectedId?: string): string | undefined {
  const live = tasks.filter(open);
  if (chosenId) return live.some((task) => task.threadId === chosenId) ? undefined : oldestThread(live.filter((task) => !task.openedBy)) ?? oldestThread(live);
  const asked = live.reduce<MainThreadCandidate | undefined>(
    (latest, task) => ((task.askedAt ?? -1) > (latest?.askedAt ?? -1) ? task : latest), undefined,
  );
  return asked?.threadId ?? live.find((task) => task.threadId === selectedId)?.threadId ?? oldestThread(live);
}

/** The conversation whose saves stay in the bot's own memory: the one the person set as main while it is open, else the
 * oldest, archived or not. Unlike mainThread it does not follow where the person last wrote, so a conversation's notes
 * keep their scope. */
export function memoryHomeThread(tasks: readonly MainThreadCandidate[], chosenId?: string): string | undefined {
  const conversations = tasks.filter((task) => !task.routineRunId);
  if (chosenId && conversations.some((task) => task.threadId === chosenId && task.archivedAt === undefined)) return chosenId;
  return conversations.reduce<MainThreadCandidate | undefined>((oldest, task) => (!oldest || task.createdAt < oldest.createdAt ? task : oldest), undefined)?.threadId;
}
