import { useSyncExternalStore } from "react";

// Simple vs Advanced. Simple is the app a non-technical person meets first;
// Advanced shows every technical control. This only hides controls: no
// setting, conversation or server configuration changes with it.
export const ADVANCED_MODE_KEY = "omb-advanced-mode";

// Keys an earlier run of this app has written. With no explicit choice
// stored, their presence means "existing install", which keeps Advanced so an
// update never hides a control someone already uses. Must be read before
// main.tsx's first-paint writes (applySkin stamps omb-skin on every boot).
const PRIOR_RUN_KEYS = ["omb-skin", "omb-installed", "omb-email-gate", "omb-drafts", "omb-show-threads"];

// Keep a session choice even if private/blocked storage rejects reads or
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

export function readAdvancedMode(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    const store = storage();
    const stored = store?.getItem(ADVANCED_MODE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return PRIOR_RUN_KEYS.some((key) => store?.getItem(key) != null);
  } catch {
    return false;
  }
}

/** Store the computed default once, before anything else writes its own
 * first-run keys — otherwise every fresh install would look like an old one
 * by the second launch. */
export function settleAdvancedModeDefault(): void {
  try {
    if (storage()?.getItem(ADVANCED_MODE_KEY) == null) setAdvancedMode(readAdvancedMode());
  } catch {
    // Storage blocked: the hook falls back to Simple for this session.
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== ADVANCED_MODE_KEY && event.key !== null) return;
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

export function setAdvancedMode(enabled: boolean): void {
  sessionChoice = enabled;
  try {
    storage()?.setItem(ADVANCED_MODE_KEY, enabled ? "1" : "0");
  } catch {
    // The switch still takes effect for this session when storage is full.
  }
  notify();
}

export function useAdvancedMode(): boolean {
  return useSyncExternalStore(subscribe, readAdvancedMode, () => false);
}
