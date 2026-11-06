// One bot's reading loop for a chat app, whichever way the app is read: Telegram holds a request open until a message
// comes, Sendblue is asked on a timer. A read that ends in an error backs off, doubling up to a minute.
export const POLL_BACKOFF_MIN_MS = 5_000;
export const POLL_BACKOFF_MAX_MS = 60_000;
export const PAUSED_CHECK_MS = 1_000;

export type ReadResult<T> = { ok: true; items: T[]; more?: boolean } | { ok: false; error: string; retryAfterMs?: number };

export interface PollerDeps<T> {
  /** The sealed secret the read needs; empty when the bot has none. */
  token(): string;
  cursor(): number | undefined;
  read(token: string, cursor: number | undefined, signal: AbortSignal): Promise<ReadResult<T>>;
  /** One item, in order; the poller moves on only once it returns. */
  handle(item: T): Promise<void>;
  failed(error: string): void;
  log?(line: string): void;
  /** Tests: how long to wait, by reason. */
  delays?: { backoffMin?: number; backoffMax?: number; paused?: number };
  /** The wait after a read that came back with everything. A reader that holds its request open needs none. */
  interval?: number;
  /** For the log line: what is being read. */
  source: string;
}

/** Stop ends the loop; pause lets a read in flight finish but delivers nothing from it. */
export function createPoller<T>(deps: PollerDeps<T>) {
  const backoffMin = deps.delays?.backoffMin ?? POLL_BACKOFF_MIN_MS;
  const backoffMax = deps.delays?.backoffMax ?? POLL_BACKOFF_MAX_MS;
  const pausedMs = deps.delays?.paused ?? PAUSED_CHECK_MS;
  const interval = deps.interval ?? 0;
  let stopped = true;
  let paused = false;
  let backoff = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;
  let checking = false;

  async function check(): Promise<number> {
    const token = deps.token();
    if (!token) return backoffMax;
    inflight = new AbortController();
    const controller = inflight;
    try {
      const result = await deps.read(token, deps.cursor(), controller.signal);
      if (controller.signal.aborted || stopped || paused) return 0;
      if (!result.ok) {
        backoff = Math.min(backoff ? backoff * 2 : backoffMin, backoffMax);
        deps.failed(result.error);
        deps.log?.(`checking ${deps.source} failed: ${result.error}`);
        return result.retryAfterMs ?? backoff;
      }
      backoff = 0;
      for (const item of result.items) {
        if (stopped || paused) return 0;
        await deps.handle(item);
      }
      return result.more ? 0 : interval;
    } finally {
      if (inflight === controller) inflight = null;
    }
  }

  function schedule(delay: number): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      if (paused) return schedule(pausedMs);
      checking = true;
      void check()
        .catch((error: unknown) => { deps.log?.(`checking ${deps.source} failed: ${(error as Error).message}`); return backoffMin; })
        .then((next) => { checking = false; schedule(paused ? pausedMs : next); });
    }, delay);
    timer.unref?.();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      inflight?.abort();
    },
    pause() {
      paused = true;
      inflight?.abort();
    },
    resume() {
      paused = false;
    },
    busy: () => checking,
  };
}

export type Poller<T> = ReturnType<typeof createPoller<T>>;
