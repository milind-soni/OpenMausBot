// A bot's main thread is the conversation its person is in: the open thread
// they last wrote in (TaskRecord.askedAt). A routine without a thread of its
// own reports there, and with threads hidden the app opens the bot there
// (WireBot.mainThreadId, worked out only here, never by a client), so the
// one conversation a person sees is where its results land. Until someone
// writes, it is the selected thread, then the oldest one.

interface MainThreadCandidate {
  threadId: string;
  createdAt: number;
  askedAt?: number;
  archivedAt?: number;
  routineRunId?: string;
}

/** The oldest open thread, else the oldest archived one. A routine run is
 * never a conversation. Before askedAt this was every bot's main thread, and
 * v0.1.98 to v0.1.107 saved it on routines as if a person had chosen it. */
export function oldestThread(tasks: readonly MainThreadCandidate[]): string | undefined {
  const visible = tasks.filter((task) => !task.routineRunId);
  const open = visible.filter((task) => task.archivedAt === undefined);
  return (open.length ? open : visible).reduce<MainThreadCandidate | undefined>(
    (oldest, task) => (!oldest || task.createdAt < oldest.createdAt ? task : oldest), undefined,
  )?.threadId;
}

/** Whether `threadId` is a thread v0.1.98 to v0.1.107 may have saved on a
 * routine as the oldest one: a conversation no open thread is older than.
 * Archived since counts: those versions kept reporting into it, and today's
 * oldest open thread is then another. */
export function wasOldestThread(tasks: readonly MainThreadCandidate[], threadId: string): boolean {
  const saved = tasks.find((task) => task.threadId === threadId && !task.routineRunId);
  return saved !== undefined && !tasks.some((task) => !task.routineRunId && task.archivedAt === undefined && task.createdAt < saved.createdAt);
}

/** The open thread a person last wrote in; else `selectedId` while it is an
 * open conversation; else the oldest thread. */
export function mainThread(tasks: readonly MainThreadCandidate[], selectedId?: string): string | undefined {
  const open = tasks.filter((task) => !task.routineRunId && task.archivedAt === undefined);
  const asked = open.reduce<MainThreadCandidate | undefined>(
    (latest, task) => ((task.askedAt ?? -1) > (latest?.askedAt ?? -1) ? task : latest), undefined,
  );
  return asked?.threadId ?? open.find((task) => task.threadId === selectedId)?.threadId ?? oldestThread(tasks);
}
