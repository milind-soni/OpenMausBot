import { useSyncExternalStore } from "react";

const STORAGE_KEY = "omb-favorite-models";
const NONE: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let current: ReadonlySet<string> | null = null;

export const favoriteKey = (instanceId: string, model: string) => `${instanceId}\n${model}`;

function read(): ReadonlySet<string> {
  if (current) return current;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    current = Array.isArray(saved) ? new Set(saved.filter((entry): entry is string => typeof entry === "string")) : NONE;
  } catch {
    current = NONE;
  }
  return current;
}

/** The models starred on this device. */
export const favoriteModels = read;

export function toggleFavoriteModel(instanceId: string, model: string): void {
  const key = favoriteKey(instanceId, model);
  const next = new Set(read());
  if (!next.delete(key)) next.add(key);
  current = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); } catch {}
  for (const listener of listeners) listener();
}

export function useFavoriteModels(): ReadonlySet<string> {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, read, () => NONE);
}

export function forgetFavoriteModelsForTest(): void {
  current = null;
}
