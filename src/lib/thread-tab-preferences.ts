import { useSyncExternalStore } from "react";

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Threads a bot started on its own (a routine run, a burst, a hand-off) that the person opened as a tab on this device.
 * They never become tabs by themselves, so the choice is this device's alone, like the threads switch in thread-preferences.ts. */
export const OPENED_THREAD_TABS_KEY = "omb-thread-tabs-opened";
const OPENED_LIMIT = 200;
const NONE: ReadonlySet<string> = new Set();
let openedCache: { raw: string | null; ids: ReadonlySet<string> } | undefined;
const openedListeners = new Set<() => void>();

export function openedThreadTabs(): ReadonlySet<string> {
  let raw: string | null;
  try {
    const store = storage();
    if (!store) return openedCache?.ids ?? NONE;
    raw = store.getItem(OPENED_THREAD_TABS_KEY);
  } catch {
    return openedCache?.ids ?? NONE;
  }
  if (openedCache && openedCache.raw === raw) return openedCache.ids;
  let ids: string[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === "string");
  } catch {
  }
  openedCache = { raw, ids: new Set(ids) };
  return openedCache.ids;
}

export function setThreadTabOpened(threadId: string, opened: boolean): void {
  const ids = [...openedThreadTabs()].filter((id) => id !== threadId);
  if (opened) ids.push(threadId);
  const raw = JSON.stringify(ids.slice(-OPENED_LIMIT));
  openedCache = { raw, ids: new Set(ids.slice(-OPENED_LIMIT)) };
  try {
    storage()?.setItem(OPENED_THREAD_TABS_KEY, raw);
  } catch {
  }
  for (const listener of openedListeners) listener();
}

function subscribeOpened(listener: () => void): () => void {
  openedListeners.add(listener);
  return () => openedListeners.delete(listener);
}

export function useOpenedThreadTabs(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeOpened, openedThreadTabs, () => NONE);
}
