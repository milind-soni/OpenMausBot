/** Why the app dropped a person's browser input before sending it. The server counts these for a bug report. */
export type InputDropReason = "stale_after_wait" | "queue_full" | "queue_halted" | "send_failed" | "take_failed" | "not_connected" | "held_elsewhere";

/**
 * Counts dropped input and hands the counts to `send` a little later, several drops in one request. Counts wait while
 * `ready` is false and go with the next ones; a failed send is not retried. Security: only reason codes and counts leave
 * the app, never what was typed or where.
 */
export function createInputDropReport(send: (counts: Partial<Record<InputDropReason, number>>) => Promise<unknown>, ready: () => boolean, delayMs = 2_000) {
  let counts: Partial<Record<InputDropReason, number>> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const flush = () => {
    timer = undefined;
    if (closed || !ready() || !Object.keys(counts).length) return;
    const batch = counts;
    counts = {};
    void send(batch).catch(() => undefined);
  };
  const arm = () => { if (!closed && timer === undefined && Object.keys(counts).length) timer = setTimeout(flush, delayMs); };
  return {
    count(reason: InputDropReason) {
      if (closed) return;
      counts[reason] = (counts[reason] ?? 0) + 1;
      arm();
    },
    /** The view connected: counts kept meanwhile may go. */
    kick: arm,
    close() { closed = true; clearTimeout(timer); timer = undefined; },
  };
}
