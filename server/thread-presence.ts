// When a person last had each conversation in front of them: wrote in it from any channel, or opened or read it in the app.
// A conversation nobody has in front of them (a teammate's delegated work, a routine) needs no warm engine.

const SEEN_MAX = 2_000;
const sightings = new Map<string, number>();
const seenListeners = new Set<(threadId: string) => void>();

/** The last time a person asked something in a thread, from any channel; a turn nobody asked for clears it. Each ask is
 * also a sighting, which that clearing leaves standing. */
export const personAsks = new (class extends Map<string, number> {
  override set(threadId: string, at: number): this {
    sight(threadId, at);
    return super.set(threadId, at);
  }
})();

function sight(threadId: string, at: number): void {
  sightings.delete(threadId);
  sightings.set(threadId, at);
  if (sightings.size > SEEN_MAX) sightings.delete(sightings.keys().next().value!);
}

/** A person had this thread in front of them: opened or read it in the app, or asked in it. Listeners hear an open or a
 * read, not an ask: an ask starts a turn of its own. */
export function sawThread(threadId: string, at: number = Date.now()): void {
  sight(threadId, at);
  for (const listener of seenListeners) {
    try { listener(threadId); } catch (error) { console.warn(`thread presence: ${(error as Error).message}`); }
  }
}

/** Hears every thread a person opens, reads or is active in; returns the unsubscribe. */
export function onThreadSeen(listener: (threadId: string) => void): () => void {
  seenListeners.add(listener);
  return () => seenListeners.delete(listener);
}

/** Whether a person wrote in, opened or read this thread within the last `ms`. */
export function seenWithin(threadId: string, ms: number, now: number = Date.now()): boolean {
  return now - (sightings.get(threadId) ?? -Infinity) <= ms;
}

export function forgetPresence(): void {
  sightings.clear();
  personAsks.clear();
}
