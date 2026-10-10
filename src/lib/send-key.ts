import { useSyncExternalStore } from "react";

import { activeLocale } from "./i18n";
import { isMacPlatform } from "./keyboard-shortcuts";

export const SEND_KEY_KEY = "omb-send-key";

/** Which Enter sends from a message box (Settings → Appearance). "enter":
 * Enter sends, Shift+Enter adds a line. "shift-enter" and "mod-enter" (Ctrl,
 * ⌘ on a Mac) make Enter add a line instead, for people whose input method
 * confirms a conversion with Enter (Japanese, as in Slack's setting).
 * Ctrl/⌘+Enter sends whatever the choice; every other Enter adds a line. */
export const SEND_KEYS = ["enter", "shift-enter", "mod-enter"] as const;
export type SendKey = (typeof SEND_KEYS)[number];

/** The send key before anyone chooses: Ctrl/⌘+Enter when the app speaks
 * Japanese, whose input method confirms every conversion with Enter, so a
 * confirming Enter can never send half a sentence; Enter everywhere else. */
export function defaultSendKey(locale: string = activeLocale()): SendKey {
  return locale === "ja" || locale.startsWith("ja-") ? "mod-enter" : "enter";
}

export function parseSendKey(value: string | null | undefined, fallback: SendKey = defaultSendKey()): SendKey {
  return SEND_KEYS.find((mode) => mode === value) ?? fallback;
}

/** An input method is composing, so this key (Enter, an arrow, Tab, Escape)
 * is its own: isComposing, or keyCode 229 for the confirming Enter WebKit
 * delivers after compositionend. A box's pickers and send leave it alone. */
export function imeComposing(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** Whether this keydown in a multi-line message box sends it; otherwise the
 * browser inserts the line break. Never while an input method is composing.
 * Single-line fields keep their plain Enter. */
export function sendsMessage(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode">,
  mode: SendKey,
): boolean {
  if (event.key !== "Enter" || imeComposing(event)) return false;
  if (event.ctrlKey || event.metaKey) return true;
  return mode === "enter" ? !event.shiftKey : mode === "shift-enter" && event.shiftKey;
}

/** The sending key as the setting, hints and tooltips name it. */
export function sendKeyLabel(mode: SendKey, mac: boolean = isMacPlatform()): string {
  return mode === "enter" ? "Enter" : mode === "shift-enter" ? "Shift+Enter" : mac ? "⌘+Enter" : "Ctrl+Enter";
}

// Only a renderer preference, like thread-preferences.ts: a session choice
// survives blocked or full storage, and another window's storage event
// supersedes it.
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
    // The visible setting still changes for this session when storage is full.
  }
  notify();
}

export function useSendKey(): SendKey {
  return useSyncExternalStore(subscribe, sendKey, () => defaultSendKey());
}
