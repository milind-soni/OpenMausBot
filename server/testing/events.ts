// Event recorder for adapter tests: await the event that proves the behaviour instead of sleeping.
import type { ProviderAdapter, RuntimeEvent } from "../contracts.ts";

export interface EventRecorder {
  events: RuntimeEvent[];
  /** Resolves with the first event matching `pred` (including already-seen
   * ones). Rejects after `timeoutMs` with the transcript so far. */
  until(pred: (e: RuntimeEvent) => boolean, timeoutMs?: number): Promise<RuntimeEvent>;
  stop(): void;
}

export function recordEvents(adapter: ProviderAdapter): EventRecorder {
  const events: RuntimeEvent[] = [];
  const waiters: Array<{ pred: (e: RuntimeEvent) => boolean; resolve: (e: RuntimeEvent) => void }> = [];
  const unsubscribe = adapter.onEvent((event) => {
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(event)) {
        const [w] = waiters.splice(i, 1);
        w.resolve(event);
      }
    }
  });
  return {
    events,
    until(pred, timeoutMs = 10_000) {
      const seen = events.find(pred);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const waiter = { pred, resolve: (e: RuntimeEvent) => (clearTimeout(timer), resolve(e)) };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(
            new Error(
              `no matching event within ${timeoutMs}ms; saw: ${events.map((e) => e.type).join(", ") || "(none)"}`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        waiters.push(waiter);
      });
    },
    stop: unsubscribe,
  };
}
