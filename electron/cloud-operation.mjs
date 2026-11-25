// What the Admin says while an operation of its own has a Cloud down: an update, a resize, a move, a disk move, a restore or
// a start (the session's `cloud.operation` and each `clouds[].operation`, additive). The window then says what is happening
// instead of "can't be reached", and goes on looking by itself. Display only: it never opens, wakes or pairs anything.

/** The kinds this app has its own words for; another kind the Admin adds later reads as "restarting". */
export const CLOUD_OPERATION_KINDS = Object.freeze(["update", "resize", "move", "disk", "restore", "start"]);
/** While the Admin says an operation has a Cloud down, its session is read this often, so the window follows it closely. */
export const OPERATION_REFRESH_MS = 15_000;

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
 * session's list (a team's Cloud, another of the person's own). Null while signed out, for any other address, or when none. */
export function cloudOperationAt(state, origin) {
  if (state?.status !== "connected" || typeof origin !== "string" || !origin) return null;
  const mine = state.machine;
  if (mine?.origin === origin && mine.operation) return mine.operation;
  const listed = Array.isArray(state.clouds) ? state.clouds.find((cloud) => cloud.origin === origin) : null;
  return listed?.operation ?? null;
}

/** Whether any Cloud in the session is down for an operation now (its session is then read every OPERATION_REFRESH_MS). */
export const anyOperation = (machine, clouds) => Boolean(machine?.operation) || (Array.isArray(clouds) && clouds.some((cloud) => Boolean(cloud?.operation)));
