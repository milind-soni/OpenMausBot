import { useSyncExternalStore } from "react";

import { CHAT_WIDTH_KEY } from "./chat-width";
import { FONT_KEY } from "./fonts";
import { ADVANCED_MODE_KEY, setAdvancedMode, settleAdvancedModeDefault } from "./interface-mode";
import { hasPriorRun } from "./prior-run";
import { RUN_CARD_KEY } from "./run-card-preferences";
import { SIMPLE_ONLY } from "./simple-only";
import { SHOW_THREADS_KEY } from "./thread-preferences";
import { WEB_PANELS_KEY } from "./web-panel-preferences";

/** What this browser's mode was when Simple became the only one: "due" (Advanced; the one-time notice is owed), "seen"
 * (Advanced; it was closed) or "none" (Simple, or a new install). Absent until a Simple-only app first booted here. */
export const NEW_LOOK_KEY = "omb-new-look";

/** Device settings only Advanced mode could change: each goes back to its default once. The sidebar's are spelled out,
 * since importing its module would put zod in the first page's bundle. */
export const ADVANCED_ONLY_PREFS = [FONT_KEY, CHAT_WIDTH_KEY, SHOW_THREADS_KEY, RUN_CARD_KEY, WEB_PANELS_KEY,
  "openmausbot.sidebarToolsLayout", "openmausbot.pinnedCircles", "openmausbot.universalPins"];

/** Where this page cannot write its storage, its memory stands in, so the notice still closes for the session. */
let seenHere = false;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function settleInterfaceMode(): void {
  try {
    const store = storage();
    const look = store?.getItem(NEW_LOOK_KEY);
    if (!SIMPLE_ONLY) {
      // Switched back: the mode this browser had before its key was retired.
      if (look && store?.getItem(ADVANCED_MODE_KEY) == null) setAdvancedMode(look !== "none");
      settleAdvancedModeDefault();
      return;
    }
    if (!store) return;
    if (look == null) {
      const stored = store.getItem(ADVANCED_MODE_KEY);
      const advanced = stored === "1" || (stored == null && hasPriorRun(store));
      for (const key of ADVANCED_ONLY_PREFS) store.removeItem(key);
      store.setItem(NEW_LOOK_KEY, advanced ? "due" : "none");
    }
    store.removeItem(ADVANCED_MODE_KEY);
  } catch {
  }
}

export function newLookDue(): boolean {
  if (seenHere) return false;
  try {
    return storage()?.getItem(NEW_LOOK_KEY) === "due";
  } catch {
    return false;
  }
}

export function markNewLookSeen(): void {
  try {
    storage()?.setItem(NEW_LOOK_KEY, "seen");
  } catch {
    seenHere = true;
  }
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== NEW_LOOK_KEY && event.key !== null) return;
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

/** Owed in this browser and not yet closed, in this tab or another. */
export function useNewLookDue(): boolean {
  return useSyncExternalStore(subscribe, newLookDue, () => false);
}
