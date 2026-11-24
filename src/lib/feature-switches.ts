import { useSyncExternalStore } from "react";

/** Switches on Settings → Features that only change how this device shows things, kept in this device's storage. */
export type DeviceFeature = "mascotMotion" | "threadNotes";

const KEYS: Record<DeviceFeature, string> = {
  mascotMotion: "omb-feature-mascot-motion",
  threadNotes: "omb-feature-thread-notes",
};

const sessionChoice = new Map<DeviceFeature, boolean>();
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readDeviceFeature(name: DeviceFeature): boolean {
  const chosen = sessionChoice.get(name);
  if (chosen !== undefined) return chosen;
  try {
    return storage()?.getItem(KEYS[name]) !== "0";
  } catch {
    return true;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && !Object.values(KEYS).includes(event.key)) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice.clear();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function setDeviceFeature(name: DeviceFeature, enabled: boolean): void {
  sessionChoice.set(name, enabled);
  try {
    storage()?.setItem(KEYS[name], enabled ? "1" : "0");
  } catch {
  }
  notify();
}

export function useDeviceFeature(name: DeviceFeature): boolean {
  const read = () => readDeviceFeature(name);
  return useSyncExternalStore(subscribe, read, read);
}
