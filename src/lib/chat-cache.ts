import { createContext } from "react";
import type { Message } from "../state/store";

export type HistoryPage = { messages: Message[]; hasMore: boolean; activeLeafId?: string | null };
export const ChatCacheScope = createContext<string | null>(null);
const day = 86_400_000;
const policy = {
  images: { ttl: 30 * day, bytes: 128 * 1024 ** 2 },
  pages: { ttl: 7 * day, bytes: 32 * 1024 ** 2 },
};
type Kind = keyof typeof policy;
type Values = { images: Blob; pages: HistoryPage };
type Meta = { bytes: number; expires: number; accessed: number };
let database: Promise<IDBDatabase> | undefined;
let activeScope: string | null = null;
let expiresAt = Infinity;

function open() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("mausbot-chat", 1);
    request.onupgradeneeded = () => {
      indexedDB.deleteDatabase("mausbot-chat-images");
      for (const kind of Object.keys(policy)) {
        request.result.createObjectStore(kind);
        request.result.createObjectStore(kind + "-meta").createIndex("accessed", "accessed");
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  }).catch(error => { database = undefined; throw error; });
}

function finished(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

export function setChatCacheScope(scope: string | null, sessionExpiry?: number) {
  expiresAt = sessionExpiry || Infinity;
  activeScope = scope;
}

export async function clearChatCache() {
  const scope = activeScope;
  activeScope = null;
  if (!scope) return;
  try {
    const db = await open();
    const tx = db.transaction([...db.objectStoreNames], "readwrite");
    const range = IDBKeyRange.bound([scope], [scope, []]);
    for (const name of db.objectStoreNames) tx.objectStore(name).delete(range);
    await finished(tx);
  } catch { /* Storage can be unavailable in private browsing. */ }
}

export async function readChatCache<K extends Kind>(kind: K, scope: string, id: string): Promise<Values[K] | undefined> {
  try {
    const db = await open();
    if (scope !== activeScope || Date.now() >= expiresAt) return;
    const tx = db.transaction([kind, kind + "-meta"], "readwrite");
    const meta = tx.objectStore(kind + "-meta");
    const data = tx.objectStore(kind);
    const key = [scope, id];
    const request = meta.get(key);
    let value: Values[K] | undefined;
    request.onsuccess = () => {
      const row: Meta | undefined = request.result;
      if (!row) return;
      if (row.expires <= Date.now()) { meta.delete(key); data.delete(key); return; }
      const newest = meta.index("accessed").openKeyCursor(null, "prev");
      newest.onsuccess = () => meta.put({ ...row, accessed: Number(newest.result?.key ?? 0) + 1 }, key);
      const content = data.get(key);
      content.onsuccess = () => { value = content.result; };
    };
    await finished(tx);
    if (scope === activeScope && Date.now() < expiresAt) return value;
  } catch { /* A cache miss falls through to the network. */ }
}

export async function writeChatCache<K extends Kind>(kind: K, scope: string, id: string, value: Values[K]) {
  try {
    const db = await open();
    if (scope !== activeScope || Date.now() >= expiresAt) return;
    const { ttl, bytes: limit } = policy[kind];
    const bytes = value instanceof Blob ? value.size : new Blob([JSON.stringify(value)]).size;
    const tx = db.transaction([kind, kind + "-meta"], "readwrite");
    const meta = tx.objectStore(kind + "-meta");
    const data = tx.objectStore(kind);
    const key = [scope, id];
    const now = Date.now();
    // Walk only metadata, most recently used first. Never deserialize other images to evict them.
    meta.delete(key);
    data.delete(key);
    if (bytes <= limit) {
      let used = bytes;
      let accessed = 1;
      const walk = meta.index("accessed").openCursor(null, "prev");
      walk.onsuccess = () => {
        const cursor = walk.result;
        if (!cursor) {
          data.put(value, key);
          meta.put({ bytes, expires: now + ttl, accessed } satisfies Meta, key);
          return;
        }
        const row: Meta = cursor.value;
        accessed = Math.max(accessed, row.accessed + 1);
        if (row.expires <= now || used + row.bytes > limit) {
          data.delete(cursor.primaryKey);
          cursor.delete();
          if (row.expires > now) used = limit;
        } else used += row.bytes;
        cursor.continue();
      };
    }
    await finished(tx);
  } catch { /* Quota or storage errors must not prevent display. */ }
}
