// A scheduled occurrence that does not run always leaves a `missed` row saying why. Occurrences skipped for one cause
// (the same earlier run still going, the same spacing after a cloud computer that did not start) share one row, which
// counts them and keeps the first and last time: a schedule every minute behind a run of hours adds one row, not hundreds.
import { ROUTINE_DEFERRAL_NOTICE_MS } from "./routine-execution.ts";
import { codedLine, type RoutineLineKey } from "./routine-lines.ts";
import type { RoutineRun } from "./routines.ts";

/** What a `missed` row stands for when it counts skipped occurrences. */
export interface RoutineSkips {
  /** Occurrences skipped for this cause. */
  count: number;
  /** The scheduled times of the first and the last of them. */
  firstAt: number;
  lastAt: number;
  /** The cause: the id of the run they waited behind, or `no-start:` and the id of the last run whose computer did not start. */
  behind: string;
  /** The owner was told about this cause. */
  told?: true;
}

export type SkipWhy = Extract<RoutineLineKey, "routines.server.part.stillWaiting" | "routines.server.part.stillRunning" | "routines.server.part.notStarted" | "routines.server.part.computerNoStart">;

/** A run of the same routine that an occurrence is skipped behind, and, for one that waits, since when. */
export function blockingRun(runs: readonly RoutineRun[], routineId: string): { run: RoutineRun; why: SkipWhy; waitingSince?: number } | undefined {
  const active = runs.filter((run) => run.routineId === routineId && ["queued", "running", "waiting"].includes(run.status));
  const run = active.find((candidate) => candidate.status === "waiting" && candidate.waitingSince !== undefined) ?? active.find((candidate) => candidate.status !== "queued") ?? active[0];
  if (!run) return undefined;
  if (run.status === "waiting" && run.waitingSince !== undefined) return { run, why: "routines.server.part.stillWaiting", waitingSince: run.waitingSince };
  return { run, why: run.status === "queued" ? "routines.server.part.notStarted" : "routines.server.part.stillRunning" };
}

/** Counts the occurrence at `scheduledFor` on its cause's row, which `make` adds the first time, and with it the
 * `earlier` occurrences that came due before it while nothing could look (routine-catch-up.ts). `tell` is true once per
 * waiting run, for the first occurrence skipped after it had waited a notice window: the owner is told then, and the row
 * shows as not yet seen. Any other skip is on a row already seen: a run that is still working when the next one comes
 * due, or a spacing the owner was told about when it began, asks nothing more of them. */
export function recordSkip(runs: readonly RoutineRun[], make: () => RoutineRun, cause: { behind: string; why: SkipWhy; waitingSince?: number }, scheduledFor: number, now: number,
  earlier?: { count: number; scheduledFor: number }): { row: RoutineRun; added: boolean; tell: boolean } {
  const found = runs.findLast((run) => run.status === "missed" && run.skipped?.behind === cause.behind);
  const row = found ?? make(), count = 1 + (earlier?.count ?? 0);
  const skipped: RoutineSkips = found?.skipped
    ? { ...found.skipped, count: found.skipped.count + count, lastAt: Math.max(found.skipped.lastAt, scheduledFor) }
    : { count, firstAt: earlier?.scheduledFor ?? scheduledFor, lastAt: scheduledFor, behind: cause.behind };
  const tell = !skipped.told && cause.waitingSince !== undefined && scheduledFor >= cause.waitingSince + ROUTINE_DEFERRAL_NOTICE_MS;
  if (tell) skipped.told = true;
  const line = skipped.count === 1 ? codedLine("error", "routines.server.skippedOne", { why: cause.why }) : codedLine("error", "routines.server.skippedMany", { count: skipped.count, why: cause.why });
  Object.assign(row, line.codes, { status: "missed", error: line.text, finishedAt: now, skipped } satisfies Partial<RoutineRun>);
  if (tell) delete row.seenAt;
  else if (!found) row.seenAt = now;
  return { row, added: !found, tell };
}

/** Skip counts as routines.json may hold them; anything out of shape is dropped. */
export function loadSkips(value: unknown): RoutineSkips | undefined {
  const skips = value as Partial<RoutineSkips> | null | undefined;
  if (!skips || typeof skips !== "object" || !Number.isSafeInteger(skips.count) || skips.count! < 1 || !Number.isSafeInteger(skips.firstAt) || !Number.isSafeInteger(skips.lastAt) ||
    typeof skips.behind !== "string" || !/^[\w:-]{1,160}$/.test(skips.behind)) return undefined;
  return { count: skips.count!, firstAt: skips.firstAt!, lastAt: skips.lastAt!, behind: skips.behind, ...(skips.told === true ? { told: true } : {}) };
}
