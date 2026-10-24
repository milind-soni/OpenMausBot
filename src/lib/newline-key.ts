import { useSyncExternalStore } from "react";
import { imeComposing, sendKeyLabel, type SendKey } from "./send-key";
import { steerKeyLabel, steersMessage, type SteerKey } from "./steer-key";

export const NEWLINE_KEY_KEY = "omb-newline-key";
export const NEWLINE_KEYS = ["auto", "enter", "shift-enter", "mod", "mod-shift", "alt"] as const;
export type NewlineKey = typeof NEWLINE_KEYS[number];
type EnterEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "keyCode">;

export function parseNewlineKey(value: string | null | undefined): NewlineKey {
  return NEWLINE_KEYS.find(key => key === value) ?? "auto";
}

export function insertsNewline(event: EnterEvent, key: NewlineKey): boolean {
  if (event.key !== "Enter" || imeComposing(event) || key === "auto") return false;
  if (key === "enter" || key === "shift-enter") {
    return !event.altKey && !event.metaKey && !event.ctrlKey && event.shiftKey === (key === "shift-enter");
  }
  return steersMessage(event, key);
}

export function newlineKeyConflict(key: NewlineKey, send?: SendKey, steer?: SteerKey): boolean {
  return key !== "auto" && (
    key === send || (key === "mod" && send === "mod-enter") || key === steer
  );
}

export function newlineKeyLabel(key: Exclude<NewlineKey, "auto">, mac?: boolean): string {
  return key === "enter" || key === "shift-enter" ? sendKeyLabel(key, mac) : steerKeyLabel(key, mac);
}

let choice: NewlineKey | undefined;
const listeners = new Set<() => void>();
const current = () => {
  if (choice !== undefined) return choice;
  try { return parseNewlineKey(globalThis.localStorage?.getItem(NEWLINE_KEY_KEY)); }
  catch { return "auto" as const; }
};
const notify = () => { for (const listener of listeners) listener(); };
const storageChanged = (event: StorageEvent) => {
  if (event.key !== NEWLINE_KEY_KEY && event.key !== null) return;
  try { if (event.storageArea && event.storageArea !== globalThis.localStorage) return; } catch { return; }
  choice = undefined;
  notify();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", storageChanged);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", storageChanged);
  };
};
export function setNewlineKey(key: NewlineKey): void {
  choice = key;
  try { globalThis.localStorage?.setItem(NEWLINE_KEY_KEY, key); } catch {}
  notify();
}
export function useNewlineKey(): NewlineKey {
  return useSyncExternalStore(subscribe, current, () => "auto");
}
