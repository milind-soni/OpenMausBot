import { useEffect, useState } from "react";

/** The bots whose threads the person unfolded under their sidebar row, on this device. Folded is the default. */
export const UNFOLDED_THREADS_KEY = "omb-unfolded-threads";
const LIMIT = 200;
const NONE: ReadonlySet<string> = new Set();
let cache: { raw: string | null; ids: ReadonlySet<string> } | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function unfoldedThreadBots(): ReadonlySet<string> {
  let raw: string | null;
  try {
    const store = storage();
    if (!store) return cache?.ids ?? NONE;
    raw = store.getItem(UNFOLDED_THREADS_KEY);
  } catch {
    return cache?.ids ?? NONE;
  }
  if (cache && cache.raw === raw) return cache.ids;
  let ids: string[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === "string");
  } catch {
  }
  cache = { raw, ids: new Set(ids) };
  return cache.ids;
}

export function setThreadsUnfolded(botId: string, unfolded: boolean): void {
  const ids = [...unfoldedThreadBots()].filter((id) => id !== botId);
  if (unfolded) ids.push(botId);
  const kept = ids.slice(-LIMIT);
  const raw = JSON.stringify(kept);
  cache = { raw, ids: new Set(kept) };
  try {
    storage()?.setItem(UNFOLDED_THREADS_KEY, raw);
  } catch {
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThreadsUnfolded(botId: string): boolean {
  const [unfolded, setUnfolded] = useState(() => unfoldedThreadBots().has(botId));
  useEffect(() => {
    const read = () => setUnfolded(unfoldedThreadBots().has(botId));
    read();
    return subscribe(read);
  }, [botId]);
  return unfolded;
}
