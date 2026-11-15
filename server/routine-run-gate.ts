/** Holds a queued run back while something it needs is made ready (its cloud computer is woken and has to answer),
 * without holding up the other runs: the work goes on beside the scheduler, which looks again when it settles.
 * `signal` aborts once the run is no longer waiting to start (cancelled, deleted, paused), so the work stops with it. */
export type RunPreparation<R> = (run: R, signal: AbortSignal) => Promise<string | null> | null;

const MAX_SETTLED = 200;

export function createRunGate<R extends { id: string }>(prepare: RunPreparation<R> | undefined, settled: () => void) {
  const pending = new Map<string, AbortController>();
  /** null: ready to start. A string: why it cannot. Read once. */
  const results = new Map<string, string | null>();

  return {
    /** false: start it. true: still being made ready. A string: it cannot start, and why. */
    hold(run: R): boolean | string {
      if (results.has(run.id)) {
        const reason = results.get(run.id)!;
        results.delete(run.id);
        return reason ?? false;
      }
      if (pending.has(run.id)) return true;
      const stop = new AbortController();
      const work = prepare?.(run, stop.signal);
      if (!work) return false;
      pending.set(run.id, stop);
      void work.catch(() => null).then((reason) => {
        if (pending.get(run.id) !== stop) return;
        pending.delete(run.id);
        if (stop.signal.aborted) return;
        if (results.size >= MAX_SETTLED) results.delete(results.keys().next().value!);
        results.set(run.id, reason);
        settled();
      });
      return true;
    },
    /** Stops the work for every held run that `waiting` no longer vouches for, and forgets its result. */
    sweep(waiting: (runId: string) => boolean): void {
      for (const [runId, stop] of pending) {
        if (waiting(runId)) continue;
        stop.abort();
        pending.delete(runId);
      }
      for (const runId of results.keys()) if (!waiting(runId)) results.delete(runId);
    },
    waiting: (runId: string): boolean => pending.has(runId),
  };
}
