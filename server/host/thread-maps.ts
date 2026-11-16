// Per-conversation maps the server keeps in memory (a turn's trigger, the model a session reported, a room's queue, ...)
// were never emptied: with many bots they grow for as long as the server runs. Each such map is tracked here; a deleted
// conversation's entries go at once, and a sweep drops those of conversations that are archived or gone.
type ThreadKeyed = { delete(threadId: string): unknown; keys(): IterableIterator<string> };

export const THREAD_MAPS_SWEEP_MS = 10 * 60_000;

export function createThreadMaps() {
  const maps: ThreadKeyed[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const forget = (threadId: string) => { for (const map of maps) map.delete(threadId); };
  /** Drops every entry whose conversation `keep` no longer wants: archived, deleted, and not running. */
  const sweep = (keep: (threadId: string) => boolean) => {
    for (const map of maps) for (const threadId of Array.from(map.keys())) if (!keep(threadId)) map.delete(threadId);
  };
  return {
    track<T extends ThreadKeyed>(map: T): T { maps.push(map); return map; },
    forget,
    sweep,
    start(keep: (threadId: string) => boolean, everyMs = THREAD_MAPS_SWEEP_MS) {
      if (timer) return;
      timer = setInterval(() => { try { sweep(keep); } catch (error) { console.warn("thread maps: sweep failed", error); } }, everyMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
    entries: () => maps.reduce((sum, map) => sum + Array.from(map.keys()).length, 0),
  };
}

export interface KeepStore {
  botByThread(threadId: string): { id: string; threadId: string } | null | undefined;
  taskByThread(botId: string, threadId: string): { archivedAt?: number } | undefined;
  groupByThread(threadId: string): unknown;
}

/** A conversation's entries stay while it runs, is open (not archived) or belongs to a room; otherwise they go. */
export const keepThreadEntry = (store: KeepStore, busy: (botId: string, threadId: string) => boolean) => (threadId: string): boolean => {
  const bot = store.botByThread(threadId);
  if (!bot) return Boolean(store.groupByThread(threadId));
  if (busy(bot.id, threadId) || bot.threadId === threadId) return true;
  const task = store.taskByThread(bot.id, threadId);
  return task !== undefined && task.archivedAt === undefined;
};
