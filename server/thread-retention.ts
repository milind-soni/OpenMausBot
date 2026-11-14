// Removes only the event logs of long-idle closed or archived threads; never transcripts or records, nor a busy, unread or handed-off thread.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { EVENTS_DIR, NATIVE_DIR } from "./config.ts";

export interface ThreadLogRetentionCandidate {
  threadId: string;
  closedAt: number | null;
  archivedAt: number | null;
  unread: boolean;
  busy: boolean;
  openDirectHandoff: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function idleSince(candidate: ThreadLogRetentionCandidate): number | null {
  const stamps = [candidate.closedAt, candidate.archivedAt].filter((value): value is number => value !== null);
  return stamps.length ? Math.max(...stamps) : null;
}

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
