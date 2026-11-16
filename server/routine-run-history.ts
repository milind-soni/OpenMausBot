import type { RoutineRun } from "./routines.ts";
import { cloneAttachments } from "./routine-attachments.ts";

const ACTIVE = new Set<RoutineRun["status"]>(["queued", "running", "waiting"]);

export function cloneRun(run: RoutineRun): RoutineRun {
  return {
    ...run,
    attachments: cloneAttachments(run.attachments),
    denials: run.denials ? [...run.denials] : undefined,
  };
}

export function compactScheduledRuns(
  runs: RoutineRun[],
  eligible: ReadonlySet<string>,
  missingThreads: ReadonlySet<string>,
  commit: (mutate: () => void) => void,
  emit?: (frame: { kind: "routine.run"; run: RoutineRun }) => void,
): number {
  if (!eligible.size) return 0;
  const newest = new Map<string, number>();
  const protectedIds = new Set<string>();
  for (const run of [...runs].sort((a, b) => b.scheduledFor - a.scheduledFor)) {
    const count = newest.get(run.routineId) ?? 0;
    if (count < 5) protectedIds.add(run.id);
    newest.set(run.routineId, count + 1);
  }
  const outputs = new Map<string, RoutineRun>();
  for (const run of runs) {
    if (run.status !== "completed" || !run.output?.trim() || !Number.isFinite(run.finishedAt ?? run.createdAt)) continue;
    const key = JSON.stringify([run.routineId, run.botId, run.target, run.runOn]);
    const previous = outputs.get(key);
    if (!previous || (run.finishedAt ?? run.createdAt) > (previous.finishedAt ?? previous.createdAt)) outputs.set(key, run);
  }
  const outputIds = new Set([...outputs.values()].map((run) => run.id));
  const changed = runs.filter((run) => eligible.has(run.id) && !protectedIds.has(run.id) &&
    run.target === "bot" && run.triggerSource === "schedule" && run.status === "completed" &&
    (run.report?.state === "posted" || run.report?.state === "quiet") && run.deliver !== "brief" &&
    (run.prompt !== undefined || run.attachments !== undefined || (!outputIds.has(run.id) && run.output !== undefined) ||
      (run.threadId !== undefined && missingThreads.has(run.threadId))));
  if (!changed.length) return 0;
  commit(() => {
    for (const run of changed) {
      delete run.prompt;
      delete run.attachments;
      if (!outputIds.has(run.id)) delete run.output;
      if (run.threadId && missingThreads.has(run.threadId)) delete run.threadId;
    }
  });
  for (const run of changed) emit?.({ kind: "routine.run", run: cloneRun(run) });
  return changed.length;
}

/** Keeps at most `max` run rows. A row that has not ended is never dropped: it owns its run's stop, limit and events.
 * Each row dropped is the oldest ended one of the routine holding the most of them, so a routine that runs every few
 * minutes uses up its own history and not the others'. */
export function evictRuns(runs: RoutineRun[], max: number): void {
  let excess = runs.length - max;
  if (excess <= 0) return;
  const ended = new Map<string, number>();
  for (const run of runs) if (!ACTIVE.has(run.status)) ended.set(run.routineId, (ended.get(run.routineId) ?? 0) + 1);
  for (; excess > 0 && ended.size > 0; excess -= 1) {
    let most = "", held = 0;
    for (const [routineId, count] of ended) if (count > held) [most, held] = [routineId, count];
    runs.splice(runs.findIndex((run) => run.routineId === most && !ACTIVE.has(run.status)), 1);
    if (held === 1) ended.delete(most); else ended.set(most, held - 1);
  }
}
