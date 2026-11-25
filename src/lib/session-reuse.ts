import type { SessionState } from "./session";

/** How long an answer serves the readers that come after it. Long enough for one screen's parts to mount, short enough
 * that nobody acts on an old answer. */
export const SESSION_REUSE_MS = 3_000;

let generation = 0;
let kept: { state: SessionState; at: number } | null = null;
let reading: Promise<SessionState> | null = null;
let watching = false;

/** Whatever may have changed who is signed in or what they may do calls this: the kept answer is dropped, and a read
 * under way is neither kept nor joined by later readers. */
export function forgetSharedSession(): void {
  generation += 1;
  kept = null;
  reading = null;
}

function watchDesktopAccount(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.ogb?.cloudAccount?.onState?.(forgetSharedSession);
}

/** One session read for readers that ask together: they share the request under way, and its answer serves those that
 * ask within SESSION_REUSE_MS. Only a session or this computer's own trust is kept; a refusal or a failed read is asked
 * again by the next reader. */
export function sharedSessionRead(read: () => Promise<SessionState>, now: () => number = Date.now): Promise<SessionState> {
  watchDesktopAccount();
  if (kept) {
    const age = now() - kept.at;
    if (age >= 0 && age < SESSION_REUSE_MS) return Promise.resolve(kept.state);
    kept = null;
  }
  if (reading) return reading;
  const asked = generation;
  const request = read().then((state) => {
    if (asked === generation && (state.kind === "session" || state.kind === "loopback")) kept = { state, at: now() };
    return state;
  }).finally(() => { if (reading === request) reading = null; });
  reading = request;
  return request;
}
