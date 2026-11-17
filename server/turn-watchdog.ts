// Room-turn watchdog. A room turn is stopped only when the bot has gone
// quiet (no runtime events for `idleMs`) or when it outlives the `maxMs`
// safety ceiling. Every event restarts the idle clock, and the idle clock is
// paused while the bot waits on the user (an open approval request), so long
// but active builds run to completion.

export type TurnExpiry = "idle" | "max";

export interface TurnWatchdog {
  /** Record runtime activity; restarts the idle clock. */
  activity(): void;
  /** The bot opened an approval request and is waiting on the user. */
  requestOpened(requestId: string): void;
  /** An approval request was answered or dismissed. */
  requestResolved(requestId: string): void;
  /** Cancel both clocks. Safe to call more than once. */
  stop(): void;
}

export function createTurnWatchdog(options: {
  idleMs: number;
  maxMs: number;
  onExpire: (reason: TurnExpiry) => void;
}): TurnWatchdog {
  const pending = new Set<string>();
  let stopped = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const expire = (reason: TurnExpiry) => {
    if (stopped) return;
    stop();
    options.onExpire(reason);
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (stopped || pending.size > 0 || options.idleMs <= 0) return;
    idleTimer = setTimeout(() => expire("idle"), options.idleMs);
  };
  const maxTimer = options.maxMs > 0 ? setTimeout(() => expire("max"), options.maxMs) : undefined;
  const stop = () => {
    stopped = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
  };

  armIdle();
  return {
    activity: armIdle,
    requestOpened(requestId) {
      pending.add(requestId);
      armIdle();
    },
    requestResolved(requestId) {
      pending.delete(requestId);
      armIdle();
    },
    stop,
  };
}

/** "20 min", "3 h", "1 h 30 min" — for the timeout activity line. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
