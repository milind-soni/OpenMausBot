// The rare background check of connections nothing used lately, so "working" never rests on a week-old success. One
// connection at a time, about once an hour (jittered), only one not used or checked for a day. It never runs while the
// machine has agreed to sleep, and it starts no request to this machine, so it never wakes it: a timer only fires on a
// machine that is already awake. A check the machine slept through is dropped, never taken for a server that is down.

/** About this often a check may start; each wait is jittered by up to a quarter either way. */
export const CHECK_EVERY_MS = 60 * 60_000;
export const CHECK_JITTER = 0.25;
/** A connection used or checked more recently than this is not checked. */
export const STALE_MS = 24 * 60 * 60_000;
/** The first check waits at least this long after start, so a boot or a wake is never spent on it. */
export const FIRST_CHECK_MS = 15 * 60_000;

export interface BackgroundCheckDeps<Ref, Outcome> {
  /** The connections due a check (none used or checked within STALE_MS), the longest unchecked first. */
  due(): Ref[];
  check(ref: Ref, signal: AbortSignal): Promise<Outcome | null>;
  record(ref: Ref, outcome: Outcome): void;
  /** The machine agreed to sleep and has not woken since. */
  asleep(): boolean;
  /** When it last woke from sleep, if it ever did. */
  wokeAt(): number | null;
  now?(): number;
  random?(): number;
  setTimer?(run: () => void, ms: number): { cancel(): void };
}

export function jitteredWait(base: number, random: () => number): number {
  return Math.round(base * (1 - CHECK_JITTER + 2 * CHECK_JITTER * random()));
}

export function createBackgroundCheck<Ref, Outcome>(deps: BackgroundCheckDeps<Ref, Outcome>) {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const setTimer = deps.setTimer ?? ((run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  });
  let timer: { cancel(): void } | null = null;
  let running: AbortController | null = null;
  let stopped = true;
  let generation = 0;

  /** One check, if one is due and the machine is awake for it. Resolves with what was checked, or null. */
  const tick = async (): Promise<Ref | null> => {
    if (running || deps.asleep()) return null;
    const ref = deps.due()[0];
    if (ref === undefined) return null;
    const startedAt = now();
    running = new AbortController();
    try {
      const outcome = await deps.check(ref, running.signal).catch(() => null);
      const woke = deps.wokeAt();
      if (outcome === null || deps.asleep() || (woke !== null && woke >= startedAt) || running.signal.aborted) return null;
      deps.record(ref, outcome);
      return ref;
    } finally {
      running = null;
    }
  };
  const schedule = (ms: number, started: number) => {
    timer = setTimer(() => {
      if (stopped || started !== generation) return;
      void tick().finally(() => { if (!stopped && started === generation) schedule(jitteredWait(CHECK_EVERY_MS, random), started); });
    }, ms);
  };

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      schedule(FIRST_CHECK_MS + jitteredWait(CHECK_EVERY_MS, random), ++generation);
    },
    stop(): void {
      stopped = true;
      timer?.cancel();
      timer = null;
      running?.abort();
    },
    tick,
  };
}
