const STORAGE_KEY = "omb.message-expansion.v1";
const MAX_EXPANDED_MESSAGES = 512;

export interface MessageExpansionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): MessageExpansionStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function entryKey(threadId: string, messageId: string): string {
  return JSON.stringify([threadId, messageId]);
}

function readExpanded(storage: MessageExpansionStorage): string[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch {
    return [];
  }
}

export function isMessageExpanded(
  threadId: string,
  messageId: string,
  storage: MessageExpansionStorage | null = defaultStorage(),
): boolean {
  return storage ? readExpanded(storage).includes(entryKey(threadId, messageId)) : false;
}

export function persistMessageExpansion(
  threadId: string,
  messageId: string,
  expanded: boolean,
  storage: MessageExpansionStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  const key = entryKey(threadId, messageId);
  const previous = readExpanded(storage).filter((item) => item !== key);
  const next = expanded ? [...previous, key].slice(-MAX_EXPANDED_MESSAGES) : previous;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Locked-down webviews may reject persistence. The in-memory UI still works.
  }
}
