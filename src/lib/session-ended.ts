import { useSyncExternalStore } from "react";
import { readSessionState } from "./session";

export const SESSION_ENDED_REASON = "Your session ended. Pair this device again to keep using it.";
const ENDED_KEY = "omb.session-ended";

let ended = false;
let checking: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** A request was refused (401/403): asks the server once whether this device is still signed in. */
export function noteRefusedRequest(): void {
  if (ended || checking) return;
  checking = readSessionState().then((state) => {
    if (state.kind !== "unauthenticated") return;
    ended = true;
    try { sessionStorage.setItem(ENDED_KEY, "1"); } catch { }
    for (const listener of listeners) listener();
  }).finally(() => { checking = null; });
}

/** The check a refused request started, if one is running. */
export function sessionCheck(): Promise<void> {
  return checking ?? Promise.resolve();
}

export function sessionEnded(): boolean {
  return ended;
}

export function useSessionEnded(): boolean {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, sessionEnded, sessionEnded);
}

/** This tab saw its session end before it reloaded: the pairing page says so. */
export function endedBeforeReload(): boolean {
  try { return sessionStorage.getItem(ENDED_KEY) === "1"; } catch { return false; }
}

export function forgetEndedSession(): void {
  try { sessionStorage.removeItem(ENDED_KEY); } catch { }
}
