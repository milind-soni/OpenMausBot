import { useSyncExternalStore } from "react";

import { useAdvancedMode } from "./interface-mode";

export const SHOW_THREADS_KEY = "omb-show-threads";
export const ALL_THREADS_MENU_KEY = "omb-all-threads-menu";

let sessionChoice: boolean | undefined;
let menuChoice: boolean | undefined;
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

function allThreadsMenu(): boolean {
  if (menuChoice !== undefined) return menuChoice;
  try {
    return storage()?.getItem(ALL_THREADS_MENU_KEY) === "1";
  } catch {
    return false;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== SHOW_THREADS_KEY && event.key !== ALL_THREADS_MENU_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  if (event.key === SHOW_THREADS_KEY) sessionChoice = undefined;
  else if (event.key === ALL_THREADS_MENU_KEY) menuChoice = undefined;
  else {
    sessionChoice = undefined;
    menuChoice = undefined;
  }
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
  }
  notify();
}

export function setAllThreadsMenu(enabled: boolean): void {
  menuChoice = enabled;
  try {
    storage()?.setItem(ALL_THREADS_MENU_KEY, enabled ? "1" : "0");
  } catch {
  }
  notify();
}

export function useShowThreadsChoice(): boolean {
  return useSyncExternalStore(subscribe, showThreads, () => true);
}

export function useAllThreadsMenu(): boolean {
  return useSyncExternalStore(subscribe, allThreadsMenu, () => false);
}

export function useShowThreads(): boolean {
  const chosen = useShowThreadsChoice();
  return useAdvancedMode() && chosen;
}
