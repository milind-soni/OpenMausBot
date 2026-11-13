import { useSyncExternalStore } from "react";
import { reportWindowPrefs } from "./window-prefs";

export const NOTIFICATION_SOUNDS_KEY = "omb-notification-sounds";
export const NOTIFICATION_FEED_KEY = "omb-notification-feed";
export const FINISHED_NOTIFICATIONS_KEY = "omb-finished-notifications";
export const NOTIFICATION_TRAY_PINNED_KEY = "omb-notification-tray-pinned";

let sessionChoice: boolean | undefined;
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

export function notificationSoundsEnabled(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return storage()?.getItem(NOTIFICATION_SOUNDS_KEY) !== "0";
  } catch {
    return true;
  }
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

export function setNotificationSounds(enabled: boolean): void {
  sessionChoice = enabled;
  try {
    const local = storage();
    const value = enabled ? "1" : "0";
    local?.setItem(NOTIFICATION_SOUNDS_KEY, value);
    if (local?.getItem(NOTIFICATION_SOUNDS_KEY) === value) sessionChoice = undefined;
  } catch {
  }
  notify();
  reportWindowPrefs();
}

export function useNotificationSounds(): boolean {
  return useSyncExternalStore(subscribe, notificationSoundsEnabled, () => true);
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
