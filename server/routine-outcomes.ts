type Outcome = { id: string; routineId: string; status: string; error?: string | null; createdAt: number; finishedAt?: number | null };

/** A routine's finished runs (failed or completed), newest first. */
export function outcomesNewestFirst<T extends Outcome>(runs: readonly T[], routineId: string, exceptRunId?: string): T[] {
  return runs.filter(run => run.routineId === routineId && run.id !== exceptRunId && (run.status === "failed" || run.status === "completed")).reverse()
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt) || b.createdAt - a.createdAt);
}

/** The run failed the same way the routine's previous outcome did. */
export function failsLikeLastOutcome<T extends Outcome>(runs: readonly T[], run: T): boolean {
  const last = outcomesNewestFirst(runs, run.routineId, run.id)[0];
  return last?.status === "failed" && last.error === run.error;
}
