import { useSyncExternalStore } from "react";

/** The published app shown beside the chat. Renderer-only: nothing about it is stored or sent anywhere. */
export interface AppPreview {
  url: string;
  title: string;
  /** The site asked for a login when last checked, so a frame would only show a sign-in it refuses to draw. */
  loginOnly?: boolean;
}

let current: AppPreview | null = null;
const listeners = new Set<() => void>();

function set(next: AppPreview | null): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export const openAppPreview = (preview: AppPreview): void => set({ ...preview });
export const closeAppPreview = (): void => set(null);

export function useAppPreview(): AppPreview | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current, () => null);
}
