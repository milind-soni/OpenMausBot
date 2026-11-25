// What the Admin says while an operation of its own has a Cloud down: an update, its rollback, a resize, a move, a disk move, a
// restore or a start (the session's `cloud.operation` and each `clouds[].operation`, additive). The window then says what is happening
// instead of "can't be reached", and goes on looking by itself. Display only: it never opens, wakes or pairs anything.

/** The kinds this app has its own words for; another kind the Admin adds later reads as "restarting". */
export const CLOUD_OPERATION_KINDS = Object.freeze(["update", "rollback", "resize", "move", "disk", "restore", "start"]);
/** While the Admin says an operation has a Cloud down, its session is read this often, so the window follows it closely. */
export const OPERATION_REFRESH_MS = 15_000;
/** The Cloud's own page asks while its live stream is down, at most this often (src/lib/cloud-work.ts): a session older than this
 * is read again first, so an ask gets a fresh word, unless the Admin itself is failing (then its own retry wait is kept). */
export const OPERATION_FRESH_MS = 8_000;
/** How long the Cloud's own page waits between asks while its live stream stays down: 10 s, then 20, 40 and 60 s from then on. */
export const OPERATION_ASK_MS = Object.freeze([10_000, 20_000, 40_000, 60_000]);
/** A screen that says what has a Cloud down stops by itself this long past the operation's own deadline (the Admin's alert has
 * gone out by then), whatever the Admin says: it is the plain "couldn't reach" again, with Try again. */
export const OPERATION_GRACE_MS = 15 * 60_000;

const KIND = /^[a-z][a-z-]{0,23}$/;
const record = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const moment = (value) => Number.isSafeInteger(value) && value > 0;

/** A malformed operation is none; a malformed estimate is left out. */
export function parseCloudOperation(input) {
  if (!record(input) || typeof input.kind !== "string" || !KIND.test(input.kind) || !moment(input.since) || !moment(input.until)) return null;
  return { kind: input.kind, since: input.since, until: input.until, ...(moment(input.expectedAt) ? { expectedAt: input.expectedAt } : {}),
    ...(input.backup === true ? { backup: true } : {}), ...(input.bigger === true ? { bigger: true } : {}) };
}

/** The operation the Admin says has the Cloud at `origin` down: My Cloud's own (the session's `cloud`), else that Cloud's in the
 * session's list (a team's Cloud, another of the person's own). Null while signed out, for any other address, or when none.
 * Never for a Cloud whose setup or update failed: that keeps its own screen and its Try again. */
export function cloudOperationAt(state, origin) {
  if (state?.status !== "connected" || typeof origin !== "string" || !origin) return null;
  const mine = state.machine;
  if (mine?.origin === origin && mine.operation) return mine.status === "failed" ? null : mine.operation;
  const listed = Array.isArray(state.clouds) ? state.clouds.find((cloud) => cloud.origin === origin) : null;
  return listed?.operation ?? null;
}

/** Whether any Cloud in the session is down for an operation now (its session is then read every OPERATION_REFRESH_MS). */
export const anyOperation = (machine, clouds) => Boolean(machine?.operation) || (Array.isArray(clouds) && clouds.some((cloud) => Boolean(cloud?.operation)));

/** When a screen that says what has a Cloud down ends by itself: by this computer's clock, from `firstSeenAt` (when it was first
 * shown for this outage), the time then left to the operation's deadline, never more than the operation's whole span (so a
 * clock ahead of or behind the Admin's moves it by at most that), plus OPERATION_GRACE_MS. */
export function operationEndsAt(operation, firstSeenAt) {
  const span = Math.max(0, operation.until - operation.since);
  return firstSeenAt + Math.min(span, Math.max(0, operation.until - firstSeenAt)) + OPERATION_GRACE_MS;
}

/** Each place's outage, from the first time its operation is shown until `clear` (the place answered): its hard end is fixed
 * then (`operationEndsAt`), so an Admin that keeps sending one, or one whose `since` moves, never keeps the screen up past it. */
export function createOperationOutages(now = Date.now) {
  const ends = new Map();
  return {
    /** `operation` while its outage's end hasn't passed; null past it, or for none. */
    shown(place, operation) {
      if (!operation) return null;
      if (!ends.has(place)) ends.set(place, operationEndsAt(operation, now()));
      return now() < ends.get(place) ? operation : null;
    },
    /** The place answered: its next operation is a new outage. */
    clear(place) { ends.delete(place); },
    /** When the outage at `place` ends, or null for none. */
    endsAt: (place) => ends.get(place) ?? null,
  };
}
