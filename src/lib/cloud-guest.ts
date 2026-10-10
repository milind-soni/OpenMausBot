// On an OMB Cloud home a device that is not one of the owner's own (a guest,
// or the owner's own device paired with chat-only access) writes only in the
// conversations it opened (docs/cloud-pro.md). Its composer is replaced by a
// "New conversation" button everywhere else, instead of a send that fails.
import { useEffect, useState } from "react";

import { readSessionState, type SessionState } from "./session";

let session: Promise<SessionState | null> | null = null;
const read = (fresh = false) => {
  if (fresh || !session) session = readSessionState().catch(() => null);
  return session;
};

/** Whether this device may write in a conversation: true, false (a guest
 * on a Cloud home, in a conversation it did not open) or null while that
 * is being asked. Everywhere else, and for the owner's own devices, true. */
export function canWriteIn(state: SessionState | null, threadId: string): boolean {
  if (state?.kind !== "session" || !state.cloudGuest) return true;
  return state.openedThreads?.includes(threadId) === true;
}

export function useCanWriteIn(threadId: string): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    setAllowed(null);
    void read().then(async (state) => {
      // A conversation this device just opened is not in the answer it had:
      // ask again once before saying no.
      const known = canWriteIn(state, threadId) ? state : await read(true);
      if (alive) setAllowed(canWriteIn(known, threadId));
    });
    return () => {
      alive = false;
    };
  }, [threadId]);
  return allowed;
}
