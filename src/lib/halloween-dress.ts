import { useSyncExternalStore } from "react";
import { COSTUME_FOR_COLOR, isHalloweenBody, type BotBodyId } from "../../shared/bot-body";
import type { MausColor } from "@/lib/mascot";

export const HALLOWEEN_DRESS_KEY = "omb-halloween-dress";

let sessionChoice: boolean | undefined;
const listeners = new Set<() => void>();
let skinObserver: MutationObserver | undefined;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readDressUp(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return storage()?.getItem(HALLOWEEN_DRESS_KEY) !== "0";
  } catch {
    return true;
  }
}

function readDressed(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.skin === "halloween" && readDressUp();
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== HALLOWEEN_DRESS_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    if (typeof MutationObserver !== "undefined") {
      skinObserver = new MutationObserver(notify);
      skinObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
      skinObserver?.disconnect();
      skinObserver = undefined;
    }
  };
}

export function setDressUp(enabled: boolean): void {
  sessionChoice = enabled;
  try {
    storage()?.setItem(HALLOWEEN_DRESS_KEY, enabled ? "1" : "0");
  } catch {
  }
  notify();
}

export function useDressUp(): boolean {
  return useSyncExternalStore(subscribe, readDressUp, readDressUp);
}

/** True while the Halloween skin is on and the bots are dressed for it. */
export function useHalloweenDressed(): boolean {
  return useSyncExternalStore(subscribe, readDressed, () => false);
}

/** The body a bot shows: its own, or its colour's costume while dressed up. A Halloween body it already wears is kept. */
export function wornBody(body: BotBodyId | null | undefined, color: MausColor, dressed: boolean): BotBodyId | undefined {
  if (!dressed || isHalloweenBody(body) || color === "silver" || color === "chrome") return body ?? undefined;
  return COSTUME_FOR_COLOR[color];
}
