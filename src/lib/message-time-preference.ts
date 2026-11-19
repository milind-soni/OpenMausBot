import { useSyncExternalStore } from "react";

export const MESSAGE_TIMES_KEY = "omb-always-show-message-times";

let sessionChoice: boolean | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function alwaysShowMessageTimes(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return storage()?.getItem(MESSAGE_TIMES_KEY) === "1";
  } catch {
    return false;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== MESSAGE_TIMES_KEY && event.key !== null) return;
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

export function setAlwaysShowMessageTimes(enabled: boolean): void {
  const value = enabled ? "1" : "0";
  sessionChoice = enabled;
  try {
    const store = storage();
    store?.setItem(MESSAGE_TIMES_KEY, value);
    if (store?.getItem(MESSAGE_TIMES_KEY) === value) sessionChoice = undefined;
  } catch {
  }
  notify();
}

export function useAlwaysShowMessageTimes(): boolean {
  return useSyncExternalStore(subscribe, alwaysShowMessageTimes, () => false);
}
