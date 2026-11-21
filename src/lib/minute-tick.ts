import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;
const listeners = new Set<() => void>();
let minute = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function currentMinute(): number {
  return Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
}

/** One timer for every reader, set for the start of the next minute, and only while something reads it. */
function schedule(): void {
  timer = setTimeout(() => {
    minute = currentMinute();
    for (const listener of listeners) listener();
    schedule();
  }, minute + MINUTE_MS - Date.now() + 1);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    minute = currentMinute();
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/** With no reader the timer is off, so the minute is read from the clock. */
function snapshot(): number {
  return timer === null ? currentMinute() : minute;
}

/** The current minute's start: a component showing the time or a time relative to now draws again as each minute turns,
 * whatever else changes. */
export function useMinuteTick(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
