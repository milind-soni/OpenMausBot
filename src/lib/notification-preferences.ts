import { useSyncExternalStore } from "react";
import { DEFAULT_SOUND_STYLE, SOUND_STYLES, type SoundChoice } from "./app-sounds/render";
import { windowPrefChanged } from "./window-pref-changes";

export const NOTIFICATION_SOUNDS_KEY = "omb-notification-sounds";
export const NOTIFICATION_FEED_KEY = "omb-notification-feed";
export const FINISHED_NOTIFICATIONS_KEY = "omb-finished-notifications";
export const NOTIFICATION_TRAY_PINNED_KEY = "omb-notification-tray-pinned";

let sessionChoice: SoundChoice | undefined;
let feedSessionChoice: boolean | undefined;
let finishedSessionChoice: boolean | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The stored value is "0" for off, a style's name, or anything else for the default style: a value saved as "1" or
 * "0" by the earlier on/off switch reads the same. */
export function parseSoundChoice(value: string | null | undefined): SoundChoice {
  if (value === "0") return "off";
  return SOUND_STYLES.find((style) => style === value) ?? DEFAULT_SOUND_STYLE;
}

function storedSoundValue(): string | null | undefined {
  try {
    return storage()?.getItem(NOTIFICATION_SOUNDS_KEY);
  } catch {
    return undefined;
  }
}

export function readSoundChoice(): SoundChoice {
  return sessionChoice ?? parseSoundChoice(storedSoundValue());
}

export function notificationSoundsEnabled(): boolean {
  return readSoundChoice() !== "off";
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== NOTIFICATION_SOUNDS_KEY && event.key !== NOTIFICATION_FEED_KEY && event.key !== FINISHED_NOTIFICATIONS_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
  feedSessionChoice = undefined;
  finishedSessionChoice = undefined;
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

function saveSoundValue(choice: SoundChoice, value: string): void {
  sessionChoice = choice;
  try {
    const local = storage();
    local?.setItem(NOTIFICATION_SOUNDS_KEY, value);
    if (local?.getItem(NOTIFICATION_SOUNDS_KEY) === value) sessionChoice = undefined;
  } catch {
  }
  notify();
  windowPrefChanged();
}

export function setSoundChoice(choice: SoundChoice): void {
  saveSoundValue(choice, choice === "off" ? "0" : choice);
}

/** Turning sounds on keeps a style already chosen. */
export function setNotificationSounds(enabled: boolean): void {
  if (enabled && readSoundChoice() !== "off") return;
  saveSoundValue(enabled ? DEFAULT_SOUND_STYLE : "off", enabled ? "1" : "0");
}

export function useNotificationSounds(): boolean {
  return useSyncExternalStore(subscribe, notificationSoundsEnabled, () => true);
}

export function useSoundChoice(): SoundChoice {
  return useSyncExternalStore(subscribe, readSoundChoice, () => DEFAULT_SOUND_STYLE);
}

export function notificationFeedEnabled(): boolean {
  if (feedSessionChoice !== undefined) return feedSessionChoice;
  try {
    return storage()?.getItem(NOTIFICATION_FEED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNotificationFeed(enabled: boolean): void {
  feedSessionChoice = enabled;
  try {
    const local = storage();
    const value = enabled ? "1" : "0";
    local?.setItem(NOTIFICATION_FEED_KEY, value);
    if (local?.getItem(NOTIFICATION_FEED_KEY) === value) feedSessionChoice = undefined;
  } catch {
  }
  notify();
}

export function useNotificationFeed(): boolean {
  return useSyncExternalStore(subscribe, notificationFeedEnabled, () => false);
}

/** Per device: "done" notices only; approvals, questions and warnings always show. */
export function finishedNotificationsEnabled(): boolean {
  if (finishedSessionChoice !== undefined) return finishedSessionChoice;
  try {
    return storage()?.getItem(FINISHED_NOTIFICATIONS_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setFinishedNotifications(enabled: boolean): void {
  finishedSessionChoice = enabled;
  try {
    const local = storage();
    const value = enabled ? "1" : "0";
    local?.setItem(FINISHED_NOTIFICATIONS_KEY, value);
    if (local?.getItem(FINISHED_NOTIFICATIONS_KEY) === value) finishedSessionChoice = undefined;
  } catch {
  }
  notify();
}

export function useFinishedNotifications(): boolean {
  return useSyncExternalStore(subscribe, finishedNotificationsEnabled, () => true);
}

/** Per device: the notification tray stays open while the person switches chats. */
export function notificationTrayPinned(): boolean {
  try {
    return storage()?.getItem(NOTIFICATION_TRAY_PINNED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNotificationTrayPinned(pinned: boolean): void {
  try {
    if (pinned) storage()?.setItem(NOTIFICATION_TRAY_PINNED_KEY, "1");
    else storage()?.removeItem(NOTIFICATION_TRAY_PINNED_KEY);
  } catch {
    // Storage can be full or blocked; the pin still holds for this session.
  }
}
