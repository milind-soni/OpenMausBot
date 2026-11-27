// A Cloud on a plan that sleeps when idle. Fly starts a sleeping machine for any request through its proxy, so this
// app's background work (Files, lending) never calls My Cloud while the Admin says it sleeps, nor after My Cloud
// answered that it is going to sleep. Without the session's `cloud.power` and without such an answer, nothing here acts.

export const CLOUD_POWER_HEADER = "x-omb-cloud-power";
/** The home never counts a request with this header as the person using My Cloud. */
export const BACKGROUND_HEADERS = Object.freeze({ "x-omb-background": "1" });
/** Longer than the home's own "going to sleep" state (120 s): a sleep that never came stops holding work back. */
export const ASLEEP_HOLD_MS = 150_000;
export const SIGNED_IN_MS = 5_000;
/** A Cloud stopped rather than suspended takes about 20 s to answer. */
export const WAKING_SIGNED_IN_MS = 30_000;
export const WAKING_SHOWN_AFTER_MS = 1_500;

export class CloudAsleepError extends Error {
  constructor() {
    super("My Cloud is asleep.");
    this.name = "CloudAsleepError";
  }
}

/** My Cloud's answer to a held or new background call while it goes to sleep. */
export const asleepAnswer = response => response?.status === 503 && response.headers?.get?.(CLOUD_POWER_HEADER) === "asleep";

/** `power()`: the Admin's last word (`{ state, since, sleeps }`) or null. `wanted()`: background work waits for My Cloud. */
export function createCloudPowerGate({ power = () => null, wanted = () => true, now = Date.now, holdMs = ASLEEP_HOLD_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let held = null, timer = null, napping = new AbortController();
  const waiters = new Set();
  const release = () => {
    held = null;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  function asleep() {
    const current = power();
    if (held && ((current && current.state !== "asleep" && current.since !== held.since) || now() - held.at >= holdMs)) release();
    return Boolean(held) || current?.state === "asleep";
  }
  function changed() {
    if (asleep()) {
      if (!napping.signal.aborted) napping.abort(new CloudAsleepError());
      return;
    }
    if (napping.signal.aborted) napping = new AbortController();
    for (const resume of Array.from(waiters)) resume();
  }
  return {
    asleep,
    changed,
    /** Something waits for My Cloud to wake: the session is then read every 15 s. */
    awaiting: () => asleep() && wanted(),
    /** Aborts when My Cloud falls asleep, for a call held open on it. */
    signal: () => napping.signal,
    /** My Cloud answered that it is going to sleep: held until the Admin reports a new power state (its `since`
     *  moves on), the person opens My Cloud, or `holdMs` passes. */
    hold() {
      if (!held) held = { at: now(), since: power()?.since ?? null };
      if (timer === null) {
        timer = setTimer(() => { timer = null; changed(); }, holdMs);
        timer?.unref?.();
      }
      changed();
    },
    /** The person opened My Cloud. */
    woke() {
      release();
      changed();
    },
    wait(signal) {
      if (signal?.aborted || !asleep()) return Promise.resolve();
      return new Promise(resolve => {
        const done = () => {
          waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    },
  };
}

/** Opening My Cloud: a sleeping one is woken through the Admin first, and its sign-in check waits out a cold start
 *  instead of pairing again. Returns that check's answer. */
export async function openSleepingCloud({ power, wake, signedIn, waking = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!power || power.state === "awake") return signedIn(SIGNED_IN_MS);
  let shown = false;
  const timer = setTimer(() => { shown = true; waking(true); }, WAKING_SHOWN_AFTER_MS);
  try {
    await Promise.resolve().then(wake).catch(() => null);
    return await signedIn(WAKING_SIGNED_IN_MS);
  } finally {
    clearTimer(timer);
    if (shown) waking(false);
  }
}
