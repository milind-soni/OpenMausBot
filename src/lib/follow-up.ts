import { useSyncExternalStore } from "react";

import { DEFAULT_FOLLOW_UP, type FollowUpDefault } from "../../shared/follow-up";
import { isMacPlatform } from "./keyboard-shortcuts";
import type { SendKey } from "./send-key";

/** What Enter does while a bot works: steer the message into the running turn, or queue it. On this device only. */
export const FOLLOW_UP_KEY = "omb-follow-up";

export function parseFollowUpDefault(value: string | null | undefined): FollowUpDefault {
  return value === "queue" || value === "steer" ? value : DEFAULT_FOLLOW_UP;
}

/** Ctrl/⌘ with the send key does the other one; when Ctrl/⌘+Enter is the send key, Shift joins it. */
export function alternateSend(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey">, mode: SendKey): boolean {
  const mod = event.ctrlKey || event.metaKey;
  return mode === "mod-enter" ? mod && event.shiftKey : mod;
}

export function alternateSendLabel(mode: SendKey, mac: boolean = isMacPlatform()): string {
  const mod = mac ? "⌘" : "Ctrl";
  return mode === "mod-enter" ? `${mod}+Shift+Enter` : `${mod}+Enter`;
}

let sessionChoice: FollowUpDefault | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readFollowUpDefault(): FollowUpDefault {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return parseFollowUpDefault(storage()?.getItem(FOLLOW_UP_KEY));
  } catch {
    return DEFAULT_FOLLOW_UP;
  }
}

function onStorage(event: StorageEvent) {
  if (event.key !== FOLLOW_UP_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
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

export function setFollowUpDefault(choice: FollowUpDefault): void {
  sessionChoice = choice;
  try {
    storage()?.setItem(FOLLOW_UP_KEY, choice);
  } catch {
  }
  for (const listener of listeners) listener();
}

export function useFollowUpDefault(): FollowUpDefault {
  return useSyncExternalStore(subscribe, readFollowUpDefault, () => DEFAULT_FOLLOW_UP);
}
