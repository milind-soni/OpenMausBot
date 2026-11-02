/** Runs `run` when `next()` says work is due, with one timer and no fixed polling. `poke()` after any change that may
 * bring work sooner. A time already past after a run means work is waiting on something outside (a busy bot, a refused
 * start): it is retried every `retryMs`. */
export interface DueTimer {
  poke(): void;
  stop(): void;
}

export interface DueTimerOptions {
  run(): Promise<void> | void;
  /** The earliest time anything is due, null when nothing is. */
  next(): number | null;
  now?: () => number;
  /** Node's timers stop while macOS sleeps (libuv's monotonic clock), so a long sleep would fire late after a wake: the
   * timer never waits longer than this. */
  maxSleepMs?: number;
  retryMs?: number;
  onError?(error: unknown): void;
}

export const DUE_MAX_SLEEP_MS = 60_000;

export function startDueTimer(options: DueTimerOptions): DueTimer {
  const now = options.now ?? Date.now;
  const maxSleepMs = options.maxSleepMs ?? DUE_MAX_SLEEP_MS;
  const retryMs = options.retryMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firesAt = Infinity;
  let running = false;
  let pokedWhileRunning = false;
  let stopped = false;

  const arm = (delay: number) => {
    if (timer) clearTimeout(timer);
    firesAt = now() + delay;
    timer = setTimeout(fire, delay);
    timer.unref?.();
  };
  const dueIn = (): number | null => {
    const at = options.next();
    return at === null ? null : Math.max(0, at - now());
  };
  const fire = () => {
    timer = null;
    firesAt = Infinity;
    if (stopped) return;
    running = true;
    pokedWhileRunning = false;
    let done: Promise<void> | void;
    try {
      done = options.run();
    } catch (error) {
      done = Promise.reject(error);
    }
    void Promise.resolve(done).catch((error) => options.onError?.(error)).finally(() => {
      running = false;
      if (stopped) return;
      const wait = dueIn();
      // A change during the run may have made work due now; anything else still due now waits on the outside.
      if (wait === 0 && pokedWhileRunning) arm(0);
      else arm(wait === null ? maxSleepMs : wait === 0 ? retryMs : Math.min(wait, maxSleepMs));
    });
  };

  fire();
  return {
    poke() {
      if (stopped) return;
      if (running) { pokedWhileRunning = true; return; }
      const wait = dueIn();
      if (wait !== null && now() + wait < firesAt) arm(Math.min(wait, maxSleepMs));
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      firesAt = Infinity;
    },
  };
}
