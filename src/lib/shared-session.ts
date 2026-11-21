import { readSessionState, type SessionState } from "./session";
import { sharedSessionRead } from "./session-reuse";

/** The session for a screen that shows who is here and what they may open: its parts share one request and the answer
 * of the last few seconds. A decision that must hold right now, such as whether this device is still signed in, asks
 * readSessionState. */
export function readSharedSessionState(): Promise<SessionState> {
  return sharedSessionRead(() => readSessionState());
}
