import { useEffect, useState, useSyncExternalStore } from "react";

import { readSessionState, type SessionState } from "./session";

let session: Promise<SessionState | null> | null = null;
const read = (fresh = false) => {
  if (fresh || !session) session = readSessionState().catch(() => null);
  return session;
};

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
      const known = canWriteIn(state, threadId) ? state : await read(true);
      if (alive) setAllowed(canWriteIn(known, threadId));
    });
    return () => {
      alive = false;
    };
  }, [threadId]);
  return allowed;
}

let reactor = "user";
let reactorRead: Promise<void> | null = null;
const reactorListeners = new Set<() => void>();
function subscribeReactor(listener: () => void): () => void {
  reactorListeners.add(listener);
  reactorRead ??= read().then((state) => {
    if (state?.kind !== "session" || !state.reactor) return;
    reactor = state.reactor;
    for (const notify of reactorListeners) notify();
  });
  return () => reactorListeners.delete(listener);
}

/** The same key outside a render's hooks: "user" until the server's answer arrives, which useReactor asks for. */
export function currentReactor(): string {
  return reactor;
}

/** Whose reactions in the chat are this viewer's: "user" unless the server keys each person of a shared workspace. */
export function useReactor(): string {
  return useSyncExternalStore(subscribeReactor, () => reactor, () => "user");
}
