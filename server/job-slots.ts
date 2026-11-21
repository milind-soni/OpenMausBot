export interface SlotOptions {
  /** Aborted while waiting: the job never starts and its place is freed. */
  signal?: AbortSignal;
  /** Turns true while it waits (someone now waits on it): it starts at once, over the limit. */
  urgent?: () => boolean;
  /** Something a person sees soon (a thread title, a new bot's setup suggestions): it waits ahead of the jobs nobody sees
   * (memory upkeep, skill review, warm summaries), behind other such jobs that came first. */
  interactive?: boolean;
  /** Called once when the job has to wait for a free slot, before run() returns its promise. */
  onWait?: () => void;
}

/** At most `limit` jobs at once, the rest in arrival order, interactive ones first. */
export interface JobSlots {
  run<T>(job: () => Promise<T>, options?: SlotOptions): Promise<T>;
  readonly limit: number;
  readonly running: number;
  readonly waiting: number;
}

export function createJobSlots(limit: number): JobSlots {
  let running = 0;
  const waiting: Array<{ start: () => void; interactive: boolean }> = [];
  // An urgent job's extra capacity must not pass to an ordinary waiter after that job ends.
  const release = () => {
    running -= 1;
    if (running >= limit) return;
    const next = waiting.shift();
    if (next) { running += 1; next.start(); }
  };
  const slot = ({ signal, urgent, interactive = false, onWait }: SlotOptions): Promise<void> => {
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
        const at = waiting.indexOf(entry);
        if (at >= 0) waiting.splice(at, 1);
      };
      // Handed a slot by a finished job: `running` already counts it.
      const entry = { interactive, start: () => { unwait(); resolve(); } };
      const leave = () => {
        unwait();
        reject(signal!.reason instanceof Error ? signal!.reason : new Error("stopped while waiting for a free slot"));
      };
      const behind = interactive ? waiting.findIndex((other) => !other.interactive) : -1;
      waiting.splice(behind < 0 ? waiting.length : behind, 0, entry);
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
      onWait?.();
    });
  };
  return {
    async run(job, options = {}) {
      await slot(options);
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
