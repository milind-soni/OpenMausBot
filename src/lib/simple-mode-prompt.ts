import { useSyncExternalStore } from "react";

/** The Simple mode popup was closed in this browser. Kept per browser, next to the mode it is about (interface-mode's
 * omb-advanced-mode), since each browser keeps its own mode. */
export const SIMPLE_MODE_PROMPT_KEY = "omb-simple-mode-prompt";

/** Where this page cannot write its storage, its memory stands in, so the popup still closes for the session. */
let closedHere = false;
const listeners = new Set<() => void>();

export function simpleModePromptSeen(): boolean {
  if (closedHere) return true;
  try {
    return globalThis.localStorage?.getItem(SIMPLE_MODE_PROMPT_KEY) === "1";
  } catch {
    // Storage this page cannot read would ask again at every launch.
    return true;
  }
}

export function markSimpleModePromptSeen(): void {
  try {
    globalThis.localStorage?.setItem(SIMPLE_MODE_PROMPT_KEY, "1");
  } catch {
    closedHere = true;
  }
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== SIMPLE_MODE_PROMPT_KEY && event.key !== null) return;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** Closed in this browser, in this tab or another. */
export function useSimpleModePromptSeen(): boolean {
  return useSyncExternalStore(subscribe, simpleModePromptSeen, () => true);
}
