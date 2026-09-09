import { useSyncExternalStore } from "react";

export const SHOW_THREADS_KEY = "omb-show-threads";

// Only a renderer preference: no conversation or server configuration belongs
// here. Keep a session choice even if private/blocked storage rejects reads or
// writes; another window's storage event can supersede that choice.
let sessionChoice: boolean | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function showThreads(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return storage()?.getItem(SHOW_THREADS_KEY) !== "0";
  } catch {
    return true;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== SHOW_THREADS_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function setShowThreads(enabled: boolean): void {
  sessionChoice = enabled;
  try {
    storage()?.setItem(SHOW_THREADS_KEY, enabled ? "1" : "0");
  } catch {
    // The visible setting still changes for this session when storage is full.
  }
  notify();
}

export function useShowThreads(): boolean {
  return useSyncExternalStore(subscribe, showThreads, () => true);
}
