// Read by the SSE fold too: auto-speak stands down for the bot on a call, or the two deadlock over the speaker.
import { useSyncExternalStore } from "react";

import { stopSpeech } from "./speech";
import { speaker } from "./tts";

let current: string | null = null;
const watchers = new Set<() => void>();

function notify() {
  for (const fn of Array.from(watchers)) fn();
}

export function currentCall(): string | null {
  return current;
}

export function startCall(targetId: string) {
  if (current === targetId) return;
  // Silence both halves before ownership changes: the old overlay may not unmount until React's next render.
  speaker.stop();
  stopSpeech();
  current = targetId;
  notify();
}

/** A targetId keeps an async teardown from call A from hanging up a newer call B. */
export function endCall(targetId?: string): boolean {
  if (targetId && current !== targetId) return false;
  if (current === null) return false;
  current = null;
  speaker.stop();
  stopSpeech();
  notify();
  return true;
}

/** Deferred: StrictMode probes effects setup -> cleanup -> setup in development. */
export function deferCallCleanup(targetId: string, isMounted: () => boolean): void {
  queueMicrotask(() => {
    if (!isMounted()) endCall(targetId);
  });
}

export function useOnCall(): string | null {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => current,
    () => current,
  );
}
