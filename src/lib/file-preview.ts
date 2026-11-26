import { useCallback, useRef, useSyncExternalStore } from "react";

import { useOptionalStoreRef } from "@/state/store-ref";
import { closeAppPreview } from "./app-preview";
import { closeSidePanels } from "./page-open";
import { closeRoomPanel } from "./room-panel";
import { SIDEBAR_AND_PANEL_FIT } from "./use-media-query";

/** A file from a message, shown beside the chat. Renderer-only: nothing about it is stored or sent anywhere. */
export interface FilePreview {
  kind: "html" | "markdown" | "text" | "table" | "changes";
  path: string;
  shownPath?: string;
  name: string;
  message: { threadId: string; messageId: string };
  /** For "changes": the person's file this one is an edit of, in the message that attached it. */
  original?: { path: string; name: string; messageId: string };
  /** What opened it, to take focus back when the person closes the pane. */
  opener: HTMLElement | null;
}

let current: FilePreview | null = null;
const listeners = new Set<() => void>();

function set(next: FilePreview | null): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/** The file each conversation the chat left had open beside it, shown again when the person comes back to it. */
const leftOpen = new Map<string, FilePreview>();

/** A file opened in a conversation replaces the one it had kept from before, so closing it leaves that conversation
 * with none. */
export function openFilePreview(preview: FilePreview): void {
  leftOpen.delete(preview.message.threadId);
  set({ ...preview });
}
export const closeFilePreview = (): void => set(null);

/** The chat moved from one conversation to another: keeps the open file for the one it left, and shows the one the
 * other had open when the person left it, if any and if `show`; otherwise that one stays kept for a later return. */
export function moveFilePreview(from: string | undefined, to: string | undefined, show: boolean): void {
  if (current && from !== undefined) leftOpen.set(from, { ...current, opener: null });
  let kept: FilePreview | null = null;
  if (show && to !== undefined) {
    kept = leftOpen.get(to) ?? null;
    leftOpen.delete(to);
  }
  set(kept);
}

/** Closes the pane and forgets the files every conversation had open. */
export function forgetFilePreviews(): void {
  leftOpen.clear();
  set(null);
}

export function useFilePreview(): FilePreview | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current, () => null);
}

/** A file opens beside the chat only from the conversation itself, never from a panel, and only when the window is
 * wide enough to keep the sidebar, the chat and the pane side by side. */
export function opensBesideChat(opener: HTMLElement | null): boolean {
  if (!opener?.closest("main[data-look='chat']") || opener.closest("aside")) return false;
  return typeof window.matchMedia === "function" && window.matchMedia(SIDEBAR_AND_PANEL_FIT).matches;
}

/** Shows the file in the pane beside the chat, in place of any other panel on that side, and answers true; false
 * leaves it to the caller's dialog. */
export function useFileBesideChat(): (preview: FilePreview) => boolean {
  const store = useOptionalStoreRef();
  const latest = useRef(store);
  latest.current = store;
  return useCallback((preview: FilePreview) => {
    const app = latest.current;
    if (!app || !opensBesideChat(preview.opener)) return false;
    closeSidePanels(app.dispatch);
    closeAppPreview();
    closeRoomPanel();
    openFilePreview(preview);
    return true;
  }, []);
}
