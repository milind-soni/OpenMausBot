/** How often each cloud computer was woken, waited for, went unanswered, was sent a call again or was restarted, since the
 * server started. Security: only the provider's opaque computer id and numbers are kept, never a command or its output,
 * so the lines are safe in a bug report. */
export type CloudComputerCount = "wakes" | "restoreWaits" | "unanswered" | "resent" | "lostAnswers" | "restarts";

interface Row {
  counts: Record<CloudComputerCount, number>;
  /** Milliseconds spent waiting, by what was waited for. */
  waited: { wakes: number; restoreWaits: number; restarts: number };
  lastAt: number;
}

const MAX_COMPUTERS = 20;
const LABELS: Array<[CloudComputerCount, string]> = [
  ["wakes", "waits for an answer after waking"], ["restoreWaits", "waits on a disk restore"], ["unanswered", "calls unanswered"],
  ["resent", "calls sent again"], ["lostAnswers", "answers lost after the call ran"], ["restarts", "restarts"],
];

export function createCloudComputerCounters(now: () => number = Date.now) {
  const rows = new Map<string, Row>();

  function count(boxId: string, what: CloudComputerCount, waitedMs = 0): void {
    let row = rows.get(boxId);
    if (!row) {
      if (rows.size >= MAX_COMPUTERS) {
        const oldest = [...rows].sort(([, a], [, b]) => a.lastAt - b.lastAt)[0];
        if (oldest) rows.delete(oldest[0]);
      }
      rows.set(boxId, row = {
        counts: { wakes: 0, restoreWaits: 0, unanswered: 0, resent: 0, lostAnswers: 0, restarts: 0 },
        waited: { wakes: 0, restoreWaits: 0, restarts: 0 }, lastAt: now(),
      });
    }
    row.counts[what] += 1;
    if (what in row.waited) row.waited[what as keyof Row["waited"]] += Math.max(0, Math.round(waitedMs));
    row.lastAt = now();
  }

  return {
    count,
    snapshot: (boxId: string): Row["counts"] | null => rows.get(boxId)?.counts ?? null,
    /** One line per computer, most recent first. */
    lines(): string[] {
      return [...rows].sort(([, a], [, b]) => b.lastAt - a.lastAt).map(([boxId, row]) => {
        const parts = LABELS.filter(([key]) => row.counts[key] > 0).map(([key, label]) => {
          const waited = key in row.waited ? row.waited[key as keyof Row["waited"]] : 0;
          return `${row.counts[key]} ${label}${waited ? ` (${Math.round(waited / 1_000)}s in all)` : ""}`;
        });
        return `${boxId}: ${parts.join(", ")}; last ${new Date(row.lastAt).toISOString()}`;
      });
    },
    clear: () => rows.clear(),
  };
}

export type CloudComputerCounters = ReturnType<typeof createCloudComputerCounters>;

export const cloudComputerCounters = createCloudComputerCounters();
