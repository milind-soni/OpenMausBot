import { useEffect, useState, type SetStateAction } from "react";

const chosen = new Map<string, boolean>();
const listeners = new Map<string, Set<() => void>>();

export function forgetSearchDisclosuresForTests(): void {
  chosen.clear();
  listeners.clear();
}

function subscribeDisclosure(key: string, onChange: () => void): () => void {
  let bucket = listeners.get(key);
  if (!bucket) {
    bucket = new Set();
    listeners.set(key, bucket);
  }
  bucket.add(onChange);
  return () => {
    bucket.delete(onChange);
    if (bucket.size === 0) listeners.delete(key);
  };
}

function publishDisclosure(key: string): void {
  const bucket = listeners.get(key);
  if (!bucket) return;
  for (const onChange of bucket) onChange();
}

export function useSearchDisclosure(
  key: string,
  query: string,
  matches: boolean,
  initial = false,
): [boolean, (next: SetStateAction<boolean>) => void] {
  const [own, setOwn] = useState(() => chosen.get(key) ?? initial);
  const [during, setDuring] = useState<boolean | null>(null);
  useEffect(() => setDuring(null), [query]);
  useEffect(() => subscribeDisclosure(key, () => {
    if (chosen.has(key)) setOwn(chosen.get(key) === true);
  }), [key]);
  const searching = Boolean(query.trim());
  const open = searching ? (during ?? matches) : own;
  const set = (next: SetStateAction<boolean>) => {
    const value = typeof next === "function" ? next(open) : next;
    if (searching) {
      setDuring(value);
      return;
    }
    chosen.set(key, value);
    setOwn(value);
    publishDisclosure(key);
  };
  return [open, set];
}

export function searchMatchesThreads(
  query: string,
  tasks: ReadonlyArray<{ title: string; routineRunId?: string }> | undefined,
  folders: ReadonlyArray<{ name: string }> | undefined = [],
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return Boolean(tasks?.some((task) => !task.routineRunId && task.title.toLowerCase().includes(q)))
    || folders.some((folder) => folder.name.toLowerCase().includes(q));
}
