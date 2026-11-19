import { useEffect, useState, type SetStateAction } from "react";

const chosen = new Map<string, boolean>();
const listeners = new Map<string, Set<() => void>>();

export function forgetThreadDisclosuresForTests(): void {
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

export function useThreadDisclosure(key: string, initial = false): [boolean, (next: SetStateAction<boolean>) => void] {
  const [open, setOpen] = useState(() => chosen.get(key) ?? initial);
  useEffect(() => subscribeDisclosure(key, () => setOpen(chosen.get(key) === true)), [key]);
  const set = (next: SetStateAction<boolean>) => {
    const value = typeof next === "function" ? next(open) : next;
    chosen.set(key, value);
    setOpen(value);
    publishDisclosure(key);
  };
  return [open, set];
}
