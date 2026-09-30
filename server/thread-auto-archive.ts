// Optional auto-archive of long-closed threads (#1280).
//
// Archive, not delete: it is reversible and keeps the thread's durable
// context — resume cursors, last instance state, cwd, and handoff state
// (#1194). Only threads closed (close_thread) longer than the configured
// window are eligible, and never one that is busy, unread, snoozed,
// pinned, carrying queued work, carrying an open direct handoff, or a
// standing peer pair conversation a peer can reopen by sending again. The
// window runs from the thread's most recent close; explicitly restoring an
// archived thread exempts it until it is closed again. The window comes
// from the global
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
  /** task.restoredAt — set when a person explicitly restored (unarchived)
   * the thread. Newer than closedAt, it exempts the thread: restoring is
   * a statement that the thread is wanted, so only closing it again
   * re-arms the window. */
  restoredAt: number | null;
  unread: boolean;
  busy: boolean;
  /** Snoozed ("until activity" or a future wake) — hidden, not filed away. */
  snoozed: boolean;
  /** Pinned above the update-ordered list — a person keeps it at hand. */
  pinned: boolean;
  /** Sends still queued for this thread behind capacity or a running turn. */
  hasQueuedWork: boolean;
  /** A standing peer pair conversation (openedBy.kind "pair"): the row is
   * reused whenever its peer sends again (resolvePairConversation), so
   * archiving it would hide the reopened conversation. */
  peerConversation: boolean;
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
    if (candidate.unread || candidate.busy || candidate.snoozed || candidate.pinned
      || candidate.hasQueuedWork || candidate.peerConversation || candidate.openDirectHandoff) continue;
    if (candidate.archivedAt !== null) continue;
    if (candidate.closedAt === null) continue;
    // Restore exemption: the newest explicit restore wins over the close
    // that would have archived the thread; a later close re-arms it.
    if (candidate.restoredAt !== null && candidate.restoredAt > candidate.closedAt) continue;
    if (candidate.closedAt >= now - candidate.autoArchiveDays * DAY_MS) continue;
    selected.push(candidate.threadId);
  }
  return selected;
}
