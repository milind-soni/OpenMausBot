import type { ServerResponse } from "node:http";

/** Signals for a bot's tool calls that outlive a check: each aborts once its request is gone, or once `sweep` finds the
 * turn's grant no longer active. Security: a revoked grant must reach a call already in flight, not only the next one. */
export function createTurnCallSignals<Grant>(isActive: (grant: Grant) => boolean) {
  const calls = new Map<AbortController, Grant>();
  return {
    signal(grant: Grant, res: ServerResponse): AbortSignal {
      const call = new AbortController();
      calls.set(call, grant);
      const onClose = () => {
        calls.delete(call);
        if (!res.writableEnded) call.abort();
      };
      if (res.closed) onClose();
      else res.once("close", onClose);
      return call.signal;
    },
    /** Called after grants are revoked. */
    sweep(): void {
      for (const [call, grant] of calls) {
        if (isActive(grant)) continue;
        calls.delete(call);
        call.abort();
      }
    },
  };
}
