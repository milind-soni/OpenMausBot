import { useSyncExternalStore } from "react";
import { imeComposing, type SendKey } from "./send-key";
import { isMacPlatform } from "./keyboard-shortcuts";

export const STEER_KEY_KEY = "omb-steer-key";
export const STEER_KEYS = ["off", "mod", "mod-shift", "alt"] as const;
export type SteerKey = typeof STEER_KEYS[number];
type EnterEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "keyCode">;

export function parseSteerKey(value: string | null | undefined): SteerKey {
  return STEER_KEYS.find(key => key === value) ?? "off";
}

export function steersMessage(event: EnterEvent, key: SteerKey): boolean {
  if (event.key !== "Enter" || imeComposing(event)) return false;
  const mod = event.ctrlKey || event.metaKey;
  if (key === "alt") return event.altKey && !mod && !event.shiftKey;
  return key !== "off" && !event.altKey && mod && event.shiftKey === (key === "mod-shift");
}

export function shortcutConflict(send: SendKey, steer: SteerKey): boolean {
  return send === "mod-enter" && steer === "mod";
}

export function steerKeyLabel(key: Exclude<SteerKey, "off">, mac = isMacPlatform()): string {
  if (key === "alt") return mac ? "Option+Enter" : "Alt+Enter";
  return `${mac ? "⌘" : "Ctrl"}${key === "mod-shift" ? "+Shift" : ""}+Enter`;
}

let choice: SteerKey | undefined;
const listeners = new Set<() => void>();
const current = () => {
  if (choice !== undefined) return choice;
  try { return parseSteerKey(globalThis.localStorage?.getItem(STEER_KEY_KEY)); }
  catch { return "off" as const; }
};
const notify = () => { for (const listener of listeners) listener(); };
const storageChanged = (event: StorageEvent) => {
  if (event.key !== STEER_KEY_KEY && event.key !== null) return;
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
export function setSteerKey(key: SteerKey): void {
  choice = key;
  try { globalThis.localStorage?.setItem(STEER_KEY_KEY, key); } catch {}
  notify();
}
export function useSteerKey(): SteerKey {
  return useSyncExternalStore(subscribe, current, () => "off");
}
