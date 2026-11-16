/** At most `limit` jobs at once, the rest in arrival order. A job whose `signal` aborts while it waits never starts; one
 * whose `urgent()` turns true while it waits (someone now waits on it) starts at once, over the limit. */
export interface JobSlots {
  run<T>(job: () => Promise<T>, signal?: AbortSignal, urgent?: () => boolean): Promise<T>;
  readonly limit: number;
  readonly running: number;
  readonly waiting: number;
}

export function createJobSlots(limit: number): JobSlots {
  let running = 0;
  const waiting: Array<() => void> = [];
  // A finished job hands its slot to the first waiter, so a caller arriving in between cannot take it.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };
  const slot = (signal?: AbortSignal, urgent?: () => boolean): Promise<void> => {
    signal?.throwIfAborted();
    if (running < limit || urgent?.()) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let poll: ReturnType<typeof setInterval> | undefined;
      const unwait = () => {
        clearInterval(poll);
        signal?.removeEventListener("abort", leave);
        const at = waiting.indexOf(start);
        if (at >= 0) waiting.splice(at, 1);
      };
      // Handed a slot by a finished job: `running` already counts it.
      const start = () => {
        unwait();
        resolve();
      };
      const leave = () => {
        unwait();
        reject(signal!.reason instanceof Error ? signal!.reason : new Error("stopped while waiting for a free slot"));
      };
      waiting.push(start);
      signal?.addEventListener("abort", leave, { once: true });
      if (urgent) {
        poll = setInterval(() => {
          if (!urgent()) return;
          unwait();
          running += 1;
          resolve();
        }, 250);
        poll.unref?.();
      }
    });
  };
  return {
    async run(job, signal, urgent) {
      await slot(signal, urgent);
      try {
        return await job();
      } finally {
        release();
      }
    },
    limit,
    get running() { return running; },
    get waiting() { return waiting.length; },
  };
}

/** A whole number from 1 to 64 in `raw`, else `fallback`. */
export function slotLimit(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(parsed) && parsed >= 1 && parsed <= 64 ? parsed : fallback;
}

/** One-off text calls nobody is waiting on (first-message suggestions, memory upkeep, skill review, thread titles): each
 * is an engine CLI process. OMB_BACKGROUND_TEXT_MAX sets how many run at once across all bots. */
export const backgroundTextSlots = createJobSlots(slotLimit(process.env.OMB_BACKGROUND_TEXT_MAX, 3));

/** git processes the checkpoints of all bots run at once; OMB_CHECKPOINT_GIT_MAX sets it. */
export const checkpointGitSlots = createJobSlots(slotLimit(process.env.OMB_CHECKPOINT_GIT_MAX, 4));
