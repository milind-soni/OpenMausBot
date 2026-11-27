// How often this app asks the MausBot Cloud Admin by itself, and how long it waits after an ask that failed. Every wait
// is spread by ±20% (`jittered`), so thousands of apps started together never ask in step, and an Admin that fails is
// asked less and less often, never sooner than its own Retry-After.

/** The session's steady re-read while the window is in front, or a move to My Cloud is under way. */
export const REFRESH_MS = 60_000;
/** The same while nobody is looking and nothing is under way: coming to the front reads it again at once (cloud-account.mjs `freshen`). */
export const IDLE_REFRESH_MS = 5 * 60_000;
/** A failed session read is tried again after each of these in turn, then the last from then on. */
export const SESSION_RETRY_MS = Object.freeze([15_000, 30_000, 60_000, 120_000, 240_000, 300_000]);
/** Any other background ask that failed (the pages and research relay tokens, the move's report, the updates answer). */
export const ASK_RETRY_MS = Object.freeze([60_000, 120_000, 300_000, 600_000, 1_800_000]);
/** A Retry-After longer than this is held to it. */
const RETRY_AFTER_MAX_MS = 60 * 60_000;
const SPREAD = 0.2;

/** `ms` spread by up to ±20%: `random()` 0.5 leaves it as it is. */
export function jittered(ms, random = Math.random) {
  const drawn = Number(random());
  const spread = Number.isFinite(drawn) ? Math.min(1, Math.max(0, drawn)) * 2 - 1 : 0;
  return Math.max(1, Math.round(ms * (1 + spread * SPREAD)));
}

/** `ms` spread down by up to 20%, never later (`random()` 0.5 leaves it as it is): a cadence the person may be watching
 * gets no staler than it was. */
export function jitteredBelow(ms, random = Math.random) {
  const drawn = Number(random());
  const spread = Number.isFinite(drawn) ? Math.abs(Math.min(1, Math.max(0, drawn)) * 2 - 1) : 0;
  return Math.max(1, Math.round(ms * (1 - spread * SPREAD)));
}

/** The wait after `failures` failed asks in a row (1 or more), from `steps`, spread; never shorter than `retryAfter`, the
 * Admin's own Retry-After in seconds (cloud-account.mjs puts it on a failed request's error). */
export function retryWait(failures, { steps = ASK_RETRY_MS, retryAfter, random = Math.random } = {}) {
  const step = steps[Math.min(Math.max(1, Math.floor(failures) || 1), steps.length) - 1];
  const asked = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, RETRY_AFTER_MAX_MS) : 0;
  return Math.max(jittered(step, random), asked);
}

/** The wait before a failed session read is tried again: longer each time up to five minutes, never before the Admin's
 * Retry-After, never past the sign-in's expiry (`expiresIn`), and with a last try 20 s before the verified answer stops
 * counting (`verifiedIn`) unless the Admin said when to come back. */
export function sessionRetryWait(failures, { retryAfter, expiresIn = Infinity, verifiedIn = 0, random = Math.random } = {}) {
  const left = verifiedIn - 20_000;
  return Math.min(retryWait(failures, { steps: SESSION_RETRY_MS, retryAfter, random }), expiresIn, left > 0 && !(retryAfter > 0) ? left : Infinity);
}

/**
 * One background ask's failures in a row: `failed(error)` notes one and says until when not to ask again, `ok()` starts
 * the count again, `waiting()` is true until then.
 */
export function createBackoff({ steps = ASK_RETRY_MS, now = Date.now, random = Math.random } = {}) {
  let failures = 0, until = 0;
  return {
    failed(error) { failures++; until = now() + retryWait(failures, { steps, retryAfter: error?.retryAfter, random }); return until; },
    ok() { failures = 0; until = 0; },
    waiting: () => until > now(),
    until: () => until,
  };
}
