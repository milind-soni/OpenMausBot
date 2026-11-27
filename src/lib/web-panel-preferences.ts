import { useSyncExternalStore } from "react";

import { parseWebPanels, type WebPanel } from "./web-panels";

export const WEB_PANELS_KEY = "omb-web-panels";

// Same shape as thread-preferences: a renderer preference that survives
// blocked storage for this session and follows other windows' edits.
let sessionPanels: WebPanel[] | undefined;
let cachedRaw: string | null | undefined;
let cachedPanels: WebPanel[] = [];
let writeFailed = false;
const listeners = new Set<() => void>();
const NONE: WebPanel[] = [];

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readPanels(): WebPanel[] {
  if (sessionPanels !== undefined) return sessionPanels;
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(WEB_PANELS_KEY) ?? null;
  } catch {
    return NONE;
  }
  // useSyncExternalStore needs a stable snapshot for an unchanged value.
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedPanels = parseWebPanels(raw);
  }
  return cachedPanels;
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== WEB_PANELS_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionPanels = undefined;
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

export function setWebPanels(panels: readonly WebPanel[]): void {
  const raw = JSON.stringify(panels);
  sessionPanels = parseWebPanels(raw);
  try {
    storage()?.setItem(WEB_PANELS_KEY, raw);
    writeFailed = false;
  } catch {
    // Kept for this session when storage is full or blocked.
    writeFailed = true;
  }
  notify();
}

/** The stored list as it is now, including another window's edit whose storage event hasn't arrived yet: base an edit on this, not on a rendered snapshot. */
export function latestWebPanels(): readonly WebPanel[] {
  if (!writeFailed) {
    try {
      const store = storage();
      if (store) return parseWebPanels(store.getItem(WEB_PANELS_KEY));
    } catch {
      // Blocked storage: fall back to this session's list.
    }
  }
  return readPanels();
}

export function useWebPanels(): WebPanel[] {
  return useSyncExternalStore(subscribe, readPanels, () => NONE);
}
