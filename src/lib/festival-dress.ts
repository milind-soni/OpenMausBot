import { useSyncExternalStore } from "react";
import { FESTIVALS, isFestival, type BotBodyId, type FestivalId } from "../../shared/bot-body";
import type { MausColor } from "@/lib/mascot";

/** Shared by every festival; the stored key keeps its Halloween name so a saved choice still applies. */
export const DRESS_UP_KEY = "omb-halloween-dress";

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
    return storage()?.getItem(DRESS_UP_KEY) !== "0";
  } catch {
    return true;
  }
}

function readFestival(): FestivalId | null {
  if (typeof document === "undefined") return null;
  const skin = document.documentElement.dataset.skin;
  return isFestival(skin) && readDressUp() ? skin : null;
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== DRESS_UP_KEY && event.key !== null) return;
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
    storage()?.setItem(DRESS_UP_KEY, enabled ? "1" : "0");
  } catch {
  }
  notify();
}

export function useDressUp(): boolean {
  return useSyncExternalStore(subscribe, readDressUp, readDressUp);
}

/** The festival whose skin is on while the bots are dressed for it, or null. */
export function useFestivalDress(): FestivalId | null {
  return useSyncExternalStore(subscribe, readFestival, () => null);
}

/** The body a bot shows: its own, or its colour's costume for the festival it is dressed for. A body from that festival it already wears is kept. */
export function wornBody(body: BotBodyId | null | undefined, color: MausColor, festival: FestivalId | null): BotBodyId | undefined {
  if (!festival || color === "silver" || color === "chrome") return body ?? undefined;
  const { bodies, costumes } = FESTIVALS[festival];
  return (bodies as readonly unknown[]).includes(body) ? body ?? undefined : costumes[color];
}
