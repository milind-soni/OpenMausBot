import { useSyncExternalStore } from "react";

const KEY = "openmausbot.sidebarHoverThreads";
let choice: boolean | undefined;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const read = () => {
  if (choice !== undefined) return choice;
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
};
const onStorage = (event: StorageEvent) => {
  if (event.key === KEY || event.key === null) { choice = undefined; notify(); }
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
};
export function setSidebarHoverThreads(enabled: boolean) {
  choice = enabled;
  try { localStorage.setItem(KEY, enabled ? "1" : "0"); } catch { }
  notify();
}
export function useSidebarHoverThreads() { return useSyncExternalStore(subscribe, read, () => false); }
