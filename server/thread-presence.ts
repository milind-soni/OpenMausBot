// When a person last had each conversation in front of them: wrote in it from any channel, or opened or read it in the app.
// A conversation nobody has in front of them (a teammate's delegated work, a routine) needs no warm engine.

const SEEN_MAX = 2_000;
const sightings = new Map<string, number>();

/** The last time a person asked something in a thread, from any channel; a turn nobody asked for clears it. Each ask is
 * also a sighting, which that clearing leaves standing. */
export const personAsks = new (class extends Map<string, number> {
  override set(threadId: string, at: number): this {
    sawThread(threadId, at);
    return super.set(threadId, at);
  }
})();

/** A person had this thread in front of them: opened or read it in the app, or asked in it. */
export function sawThread(threadId: string, at: number = Date.now()): void {
  sightings.delete(threadId);
  sightings.set(threadId, at);
  if (sightings.size > SEEN_MAX) sightings.delete(sightings.keys().next().value!);
}

/** Whether a person wrote in, opened or read this thread within the last `ms`. */
export function seenWithin(threadId: string, ms: number, now: number = Date.now()): boolean {
  return now - (sightings.get(threadId) ?? -Infinity) <= ms;
}

export function forgetPresence(): void {
  sightings.clear();
  personAsks.clear();
}
