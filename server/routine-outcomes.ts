type Outcome = { id: string; routineId: string; status: string; error?: string | null; createdAt: number; finishedAt?: number | null };

/** A routine's finished runs (failed or completed), newest first. */
export function outcomesNewestFirst<T extends Outcome>(runs: readonly T[], routineId: string, exceptRunId?: string): T[] {
  return runs.filter(run => run.routineId === routineId && run.id !== exceptRunId && (run.status === "failed" || run.status === "completed")).reverse()
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt) || b.createdAt - a.createdAt);
}

const TIME = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PATH = /(?:\b[A-Za-z]:)?(?:[\\/][\w.@~+-]+){2,}[\\/]?/g;
const TOKEN_ID = /\b(?=[\w-]*\d)[A-Za-z][\w-]*[_-][\w-]{4,}\b|\b(?=[A-Za-z_-]*\d)[\w-]{16,}\b/g;

/** A failure's words without what changes from one run to the next (times, ids, paths, numbers), so two runs that fail
 * for one reason read as the same failure. */
export function failureShape(text: string): string {
  return text.replace(TIME, "<time>").replace(UUID, "<id>").replace(PATH, "<path>").replace(TOKEN_ID, "<id>")
    .replace(/\d+(?:\.\d+)?/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The run failed the same way the routine's previous outcome did. */
export function failsLikeLastOutcome<T extends Outcome>(runs: readonly T[], run: T): boolean {
  const last = outcomesNewestFirst(runs, run.routineId, run.id)[0];
  return last?.status === "failed" && failureShape(last.error ?? "") === failureShape(run.error ?? "");
}
