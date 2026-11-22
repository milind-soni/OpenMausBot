import { useSyncExternalStore } from "react";
import { windowPrefChanged } from "./window-pref-changes";

export const SEND_AFTER_DICTATION_KEY = "omb-send-after-dictation";

let sessionChoice: boolean | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Off unless the person turned it on: a message is sent only when they choose to. */
export function sendsAfterDictation(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return storage()?.getItem(SEND_AFTER_DICTATION_KEY) === "1";
  } catch {
    return false;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== SEND_AFTER_DICTATION_KEY && event.key !== null) return;
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

export function setSendAfterDictation(enabled: boolean): void {
  // Held for this window only until it is saved: after that the saved value counts, so another window can change it.
  sessionChoice = enabled;
  try {
    const store = storage();
    if (store) {
      store.setItem(SEND_AFTER_DICTATION_KEY, enabled ? "1" : "0");
      sessionChoice = undefined;
    }
  } catch {
  }
  notify();
  windowPrefChanged();
}

export function useSendAfterDictation(): boolean {
  return useSyncExternalStore(subscribe, sendsAfterDictation, () => false);
}
