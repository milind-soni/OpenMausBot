/** Runs `run` when `next()` says work is due, with no fixed polling. `poke()` after any change that may bring work sooner.
 * A time already past after a run means work is waiting on something outside (a busy bot, a refused start): it is
 * retried every `retryMs`. */
export interface DueTimer {
  poke(): void;
  stop(): void;
}

export interface DueTimerOptions {
  run(): Promise<void> | void;
  /** The earliest time anything is due, null when nothing is. */
  next(): number | null;
  now?: () => number;
  retryMs?: number;
  onError?(error: unknown): void;
}

/** Node's timers stop while macOS sleeps (libuv's monotonic clock), so a timer set for a far time would fire late after a
 * wake. Every due timer looks at the wall clock this often, on one shared interval, and only sets a timer for work due
 * within this time. */
export const DUE_CLOCK_MS = 60_000;

const watchers = new Set<() => void>();
let clock: ReturnType<typeof setInterval> | null = null;

function watchClock(look: () => void): () => void {
  watchers.add(look);
  clock ??= setInterval(() => { for (const watcher of watchers) watcher(); }, DUE_CLOCK_MS);
  clock.unref?.();
  return () => {
    watchers.delete(look);
    if (watchers.size === 0 && clock) {
      clearInterval(clock);
      clock = null;
    }
  };
}

/** Node looks for timed-out connections on every HTTP server every 30 s by default; a minute is enough for requests whose
 * limits are minutes. */
export const IDLE_HTTP_SERVER = { connectionsCheckingInterval: DUE_CLOCK_MS };

export function startDueTimer(options: DueTimerOptions): DueTimer {
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firesAt = Infinity;
  let running = false;
  let pokedWhileRunning = false;
  let stopped = false;

  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    firesAt = Infinity;
  };
  const arm = (delay: number) => {
    disarm();
    firesAt = now() + delay;
    timer = setTimeout(fire, delay);
    timer.unref?.();
  };
  const dueIn = (): number | null => {
    const at = options.next();
    return at === null ? null : Math.max(0, at - now());
  };
  const poke = () => {
    if (stopped) return;
    if (running) { pokedWhileRunning = true; return; }
    const wait = dueIn();
    // Past on the wall clock with the timer still pending: a wake moved the clock on and left the timer with its awake time to run.
    if (wait !== null && wait <= DUE_CLOCK_MS && (now() + wait < firesAt || firesAt < now())) arm(wait);
  };
  const fire = () => {
    disarm();
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
      if (wait === 0) arm(pokedWhileRunning ? 0 : retryMs);
      else if (wait !== null && wait <= DUE_CLOCK_MS) arm(wait);
    });
  };

  const unwatch = watchClock(poke);
  fire();
  return {
    poke,
    stop() {
      stopped = true;
      unwatch();
      disarm();
    },
  };
}
