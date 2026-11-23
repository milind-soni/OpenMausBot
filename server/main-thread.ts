interface MainThreadCandidate {
  threadId: string;
  createdAt: number;
  askedAt?: number;
  archivedAt?: number;
  routineRunId?: string;
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

/** The thread a bot opens to when threads are hidden: the one the person chose (while it is open), else the open thread
 * they last wrote in, else the selected one, else the oldest. */
export function mainThread(tasks: readonly MainThreadCandidate[], selectedId?: string, chosenId?: string): string | undefined {
  const open = tasks.filter((task) => !task.routineRunId && task.archivedAt === undefined);
  if (chosenId && open.some((task) => task.threadId === chosenId)) return chosenId;
  const asked = open.reduce<MainThreadCandidate | undefined>(
    (latest, task) => ((task.askedAt ?? -1) > (latest?.askedAt ?? -1) ? task : latest), undefined,
  );
  return asked?.threadId ?? open.find((task) => task.threadId === selectedId)?.threadId ?? oldestThread(tasks);
}

/** The conversation whose saves stay in the bot's own memory: the one the person set as main while it is open, else the
 * oldest, archived or not. Unlike mainThread it does not follow where the person last wrote, so a conversation's notes
 * keep their scope. */
export function memoryHomeThread(tasks: readonly MainThreadCandidate[], chosenId?: string): string | undefined {
  const conversations = tasks.filter((task) => !task.routineRunId);
  if (chosenId && conversations.some((task) => task.threadId === chosenId && task.archivedAt === undefined)) return chosenId;
  return conversations.reduce<MainThreadCandidate | undefined>((oldest, task) => (!oldest || task.createdAt < oldest.createdAt ? task : oldest), undefined)?.threadId;
}
