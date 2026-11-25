import { useSyncExternalStore } from "react";
import { loadSidebarAttentionPinned, saveSidebarAttentionPinned } from "@/lib/sidebar-preferences";

let pinned: boolean | null = null;
const listeners = new Set<() => void>();
const current = () => (pinned ??= loadSidebarAttentionPinned());

/** Whether Active Threads stays open in the sidebar: pinned from the inbox, unpinned there or in the sidebar. */
export const useAttentionPinned = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, current, current);

export function setAttentionPinned(next: boolean): void {
  pinned = next;
  saveSidebarAttentionPinned(next);
  for (const listener of listeners) listener();
}
