import { useSyncExternalStore } from "react";

import { isMacPlatform } from "./keyboard-shortcuts";

export const SEND_KEY_KEY = "omb-send-key";

/** Which Enter sends from a message box (Settings → Appearance). "enter":
 * Enter sends, Shift+Enter adds a line. "shift-enter" and "mod-enter" (Ctrl,
 * ⌘ on a Mac) make Enter add a line instead, for people whose input method
 * confirms a conversion with Enter (Japanese, as in Slack's setting).
 * Ctrl/⌘+Enter sends whatever the choice; every other Enter adds a line. */
export const SEND_KEYS = ["enter", "shift-enter", "mod-enter"] as const;
export type SendKey = (typeof SEND_KEYS)[number];

export function parseSendKey(value: string | null | undefined): SendKey {
  return SEND_KEYS.find((mode) => mode === value) ?? "enter";
}

/** Whether this keydown in a multi-line message box sends it; otherwise the
 * browser inserts the line break. Never while an input method is composing:
 * isComposing, or keyCode 229 for the confirming Enter WebKit delivers after
 * compositionend. Single-line fields keep their plain Enter. */
export function sendsMessage(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode">,
  mode: SendKey,
): boolean {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return false;
  if (event.ctrlKey || event.metaKey) return true;
  return mode === "enter" ? !event.shiftKey : mode === "shift-enter" && event.shiftKey;
}

/** The sending key as hints and tooltips name it. */
export function sendKeyLabel(mode: SendKey, mac: boolean = isMacPlatform()): string {
  return mode === "enter" ? "Enter" : mode === "shift-enter" ? "Shift+Enter" : mac ? "⌘+Enter" : "Ctrl+Enter";
}

/** The key that adds a line instead. */
export function newLineKeyLabel(mode: SendKey): string {
  return mode === "enter" ? "Shift+Enter" : "Enter";
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
    return "enter";
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
  return useSyncExternalStore(subscribe, sendKey, () => "enter");
}
