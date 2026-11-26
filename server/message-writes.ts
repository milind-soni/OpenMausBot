// Each message row's JSON as message-db.ts writes it, for a reader that must not miss a row written while it reads the
// table in slices (attachment-references.ts). Listeners run inside the write and must be quick; one that throws is ignored.
type Listener = (json: string) => void;

const listeners = new Set<Listener>();

/** Calls `listener` with the JSON of every message row written from now until the returned stop is called. */
export function watchMessageWrites(listener: Listener): () => void {
  const own: Listener = (json) => listener(json);
  listeners.add(own);
  return () => { listeners.delete(own); };
}

export function messageWritten(json: string): void {
  for (const listener of listeners) {
    try { listener(json); } catch { /* a watcher's failure never fails the write */ }
  }
}
