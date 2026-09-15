// Retention for per-thread event logs (#1280).
//
// The events/ and native/ NDJSON logs are the bulk of on-disk data: they
// outgrow thread metadata by orders of magnitude and nothing bounded them.
// This sweep removes the log files of threads that have been idle — closed
// or archived — longer than a configured window. It never deletes
// transcripts, thread records, or workspace state, and it never touches a
// thread that is busy, unread, or carrying an open direct handoff. Group
// threads carry no close/archive stamp today, so they are out of scope
// until they grow one.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { EVENTS_DIR, NATIVE_DIR } from "./config.ts";

export interface ThreadLogRetentionCandidate {
  threadId: string;
  /** task.closedBy?.at — when close_thread last closed the thread. */
  closedAt: number | null;
  /** task.archivedAt — when the person archived the thread. */
  archivedAt: number | null;
  unread: boolean;
  busy: boolean;
  openDirectHandoff: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The newest close/archive stamp decides: a thread picked back up and
 * closed again must wait out the full window from its newest stamp. */
function idleSince(candidate: ThreadLogRetentionCandidate): number | null {
  const stamps = [candidate.closedAt, candidate.archivedAt].filter((value): value is number => value !== null);
  return stamps.length ? Math.max(...stamps) : null;
}

/** Remove the event logs of every candidate idle longer than retentionDays.
 * Returns how many threads had logs removed. Missing files simply leave
 * nothing to do — an already-swept thread is not counted again. */
export function sweepThreadEventLogs(
  candidates: Iterable<ThreadLogRetentionCandidate>,
  retentionDays: number,
  now: number = Date.now(),
): number {
  const cutoff = now - retentionDays * DAY_MS;
  let swept = 0;
  for (const candidate of candidates) {
    if (candidate.unread || candidate.busy || candidate.openDirectHandoff) continue;
    const since = idleSince(candidate);
    if (since === null || since >= cutoff) continue;
    let removedAny = false;
    for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
      const path = join(dir, `${candidate.threadId}.ndjson`);
      try {
        unlinkSync(path);
        removedAny = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          console.warn(`[retention] could not remove ${path}: ${(error as Error).message}`);
        }
      }
    }
    if (removedAny) swept++;
  }
  return swept;
}
