// Optional auto-archive of long-closed threads (#1280).
//
// Archive, not delete: it is reversible and keeps the thread's durable
// context — resume cursors, last instance state, cwd, and handoff state
// (#1194). Only threads closed (close_thread) longer than the configured
// window are eligible, and never one that is busy, unread, or carrying an
// open direct handoff. The window comes from the global
// threads.autoArchiveDays setting, overridden per bot via autoArchiveDays
// on the bot record (0 opts a single bot out). Off by default everywhere.
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AutoArchiveCandidate {
  threadId: string;
  /** Resolved window for this thread: the bot's override, else the global
   * setting. 0 or negative never selects. */
  autoArchiveDays: number;
  /** task.closedBy?.at — when close_thread last closed the thread. */
  closedAt: number | null;
  /** task.archivedAt — an already-archived thread is never re-archived. */
  archivedAt: number | null;
  unread: boolean;
  busy: boolean;
  openDirectHandoff: boolean;
}

/** Resolve the effective window for one bot: its override wins (0 = off),
 * else the global setting. Null means auto-archive stays off. */
export function effectiveAutoArchiveDays(
  globalDays: number | null,
  botOverride: number | undefined,
): number | null {
  if (botOverride !== undefined) return botOverride > 0 ? botOverride : null;
  return globalDays;
}

/** Pick the threads auto-archive may archive now, in input order. */
export function selectAutoArchiveThreads(
  candidates: Iterable<AutoArchiveCandidate>,
  now: number = Date.now(),
): string[] {
  const selected: string[] = [];
  for (const candidate of candidates) {
    if (candidate.autoArchiveDays < 1) continue;
    if (candidate.unread || candidate.busy || candidate.openDirectHandoff) continue;
    if (candidate.archivedAt !== null) continue;
    if (candidate.closedAt === null) continue;
    if (candidate.closedAt >= now - candidate.autoArchiveDays * DAY_MS) continue;
    selected.push(candidate.threadId);
  }
  return selected;
}
