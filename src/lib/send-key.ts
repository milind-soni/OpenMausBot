import { useSyncExternalStore } from "react";

import { activeLocale } from "./i18n";
import { isMacPlatform } from "./keyboard-shortcuts";

export const SEND_KEY_KEY = "omb-send-key";

/** The Enter-adds-a-line modes are for input methods that confirm a conversion with Enter (Japanese). */
export const SEND_KEYS = ["enter", "shift-enter", "mod-enter"] as const;
export type SendKey = (typeof SEND_KEYS)[number];

export function defaultSendKey(locale: string = activeLocale()): SendKey {
  return locale === "ja" || locale.startsWith("ja-") ? "mod-enter" : "enter";
}

export function parseSendKey(value: string | null | undefined, fallback: SendKey = defaultSendKey()): SendKey {
  return SEND_KEYS.find((mode) => mode === value) ?? fallback;
}

/** isComposing, or keyCode 229: WebKit delivers the confirming Enter after compositionend. */
export function imeComposing(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

export function sendsMessage(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode">,
  mode: SendKey,
): boolean {
  if (event.key !== "Enter" || imeComposing(event)) return false;
  if (event.ctrlKey || event.metaKey) return true;
  return mode === "enter" ? !event.shiftKey : mode === "shift-enter" && event.shiftKey;
}

export function sendKeyLabel(mode: SendKey, mac: boolean = isMacPlatform()): string {
  return mode === "enter" ? "Enter" : mode === "shift-enter" ? "Shift+Enter" : mac ? "⌘+Enter" : "Ctrl+Enter";
}

/** The send key held with Alt (Option on a Mac): while a bot works, the message waits for the running turn instead of joining it. */
export function queuesMessage(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "keyCode">,
  mode: SendKey,
): boolean {
  return event.altKey && sendsMessage(event, mode);
}

export function queueKeyLabel(mode: SendKey, mac: boolean = isMacPlatform()): string {
  return `${mac ? "⌥" : "Alt"}+${sendKeyLabel(mode, mac)}`;
}

let sessionChoice: SendKey | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function sendKey(): SendKey {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return parseSendKey(storage()?.getItem(SEND_KEY_KEY));
  } catch {
    return defaultSendKey();
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== SEND_KEY_KEY && event.key !== null) return;
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

export function setSendKey(mode: SendKey): void {
  sessionChoice = mode;
  try {
    storage()?.setItem(SEND_KEY_KEY, mode);
  } catch {
  }
  notify();
}

export function useSendKey(): SendKey {
  return useSyncExternalStore(subscribe, sendKey, () => defaultSendKey());
}
