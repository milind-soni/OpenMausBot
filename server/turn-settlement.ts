export interface TurnAdmissionOwnership {
  botId: string;
  token: string;
}

/** Schedule fallback cleanup for exactly the admission that currently owns
 * a turn. A later admission on the same thread and bot is a different owner
 * and must never be settled by this timer. */
export function scheduleAdmissionSettlementAfterGrace(options: {
  botId: string;
  delayMs: number;
  current: () => TurnAdmissionOwnership | undefined;
  settle: () => void;
}): boolean {
  const admission = options.current();
  if (!admission || admission.botId !== options.botId) return false;
  const pinned = { ...admission };
  const timer = setTimeout(() => {
    const current = options.current();
    if (!current || current.botId !== pinned.botId || current.token !== pinned.token) return;
    options.settle();
  }, options.delayMs);
  timer.unref?.();
  return true;
}
