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

const writable = new Map<string, boolean>();
const writableListeners = new Set<() => void>();
function subscribeWritable(listener: () => void): () => void {
  writableListeners.add(listener);
  return () => writableListeners.delete(listener);
}

/** False too for a team bot this person can only view. Null until known; a conversation opened before shows what was
 * learned then while it is read again. */
export function useCanWriteIn(threadId: string, level?: string): boolean | null {
  const allowed = useSyncExternalStore(subscribeWritable, () => writable.get(threadId) ?? null, () => null);
  useEffect(() => {
    void read().then(async (state) => {
      const known = canWriteIn(state, threadId) ? state : await read(true);
      const value = canWriteIn(known, threadId);
      if (writable.get(threadId) === value) return;
      writable.set(threadId, value);
      for (const listener of writableListeners) listener();
    });
  }, [threadId]);
  return level === "view" ? false : allowed;
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

/** True once the server says this device is a guest on someone's My Cloud; false for its owner and everywhere else. */
export function useCloudGuest(): boolean {
  const [guest, setGuest] = useState(false);
  useEffect(() => {
    let alive = true;
    void read().then((state) => {
      if (alive) setGuest(state?.kind === "session" && state.cloudGuest === true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return guest;
}
