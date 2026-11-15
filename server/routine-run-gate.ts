/** Holds a queued run back while something it needs is made ready (its cloud computer is woken and has to answer),
 * without holding up the other runs: the work goes on beside the scheduler, which looks again when it settles. */
export type RunPreparation<R> = (run: R) => Promise<string | null> | null;

const MAX_SETTLED = 200;

export function createRunGate<R extends { id: string }>(prepare: RunPreparation<R> | undefined, settled: () => void) {
  const pending = new Set<string>();
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
      const work = prepare?.(run);
      if (!work) return false;
      pending.add(run.id);
      void work.catch(() => null).then((reason) => {
        pending.delete(run.id);
        if (results.size >= MAX_SETTLED) results.delete(results.keys().next().value!);
        results.set(run.id, reason);
        settled();
      });
      return true;
    },
    waiting: (runId: string): boolean => pending.has(runId),
  };
}
